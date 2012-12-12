// Copyright (C) 2011 Colin Walters <walters@verbum.org>
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the
// Free Software Foundation, Inc., 59 Temple Place - Suite 330,
// Boston, MA 02111-1307, USA.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Format = imports.format;

const GSystem = imports.gi.GSystem;

const Task = imports.task;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Config = imports.config;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

var loop = GLib.MainLoop.new(null, true);

const Resolve = new Lang.Class({
    Name: "Resolve",

    _init: function() {
    },

    execute: function(argv) {
	let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Expand git revisions in source to exact targets");
        parser.addArgument('--manifest', {required:true,
					  help:"Path to manifest file"});
        parser.addArgument('--fetch', {action:'storeTrue',
					help:"Also perform a git fetch"});
        parser.addArgument('--fetch-keep-going', {action:'storeTrue',
						  help:"Don't exit on fetch failures"});
        parser.addArgument('components', {nargs:'*',
					  help:"List of component names to git fetch"});

        let args = parser.parse(argv);

	let componentsToFetch = {};
	args.components.forEach(function (name) {
	    componentsToFetch[name] = true;
	});

        if (args.components.length > 0 && !args.fetch) {
            throw new Error("Can't specify components without --fetch");
	}

	this.config = Config.get();
	this.workdir = Gio.File.new_for_path(this.config.getGlobal('workdir'));
        this._snapshot = JsonUtil.loadJson(Gio.File.new_for_path(args.manifest), cancellable);
	this._mirrordir = Gio.File.new_for_path(this.config.getGlobal('mirrordir'));
        this.prefix = this._snapshot['prefix'];

	let components = this._snapshot['components'];
	let resolvedComponents = [];
	for (let i = 0; i < components.length; i++) {
	    resolvedComponents.push(BuildUtil.resolveComponent(this._snapshot, components[i]));
	}
        this._snapshot['components'] = components = resolvedComponents;

        let uniqueComponentNames = {};
        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            let name = component['name'];
            if (uniqueComponentNames[name]) {
                throw new Error("Duplicate component name " + name);
	    }
            uniqueComponentNames[name] = true;
	}

        let baseMeta = BuildUtil.resolveComponent(this._snapshot, this._snapshot['base']);
        this._snapshot['base'] = baseMeta;
        let [keytype, uri] = Vcs.parseSrcKey(baseMeta['src']);
        let mirrordir = Vcs.ensureVcsMirror(this._mirrordir, keytype, uri, baseMeta['branch'], cancellable);
        if (componentsToFetch[baseMeta['name']]) {
            ProcUtil.runSync(['git', 'fetch'], cancellable, {cwd:mirrordir});
	}

        let baseRevision = Vcs.describeVersion(mirrordir, baseMeta['branch']);
        baseMeta['revision'] = baseRevision;

        let globalPatchesMeta = BuildUtil.resolveComponent(this._snapshot, this._snapshot['patches']);
        this._snapshot['patches'] = globalPatchesMeta;
        let [keytype, uri] = Vcs.parseSrcKey(globalPatchesMeta['src']);
        let mirrordir = Vcs.ensureVcsMirror(this._mirrordir, keytype, uri, globalPatchesMeta['branch'], cancellable);
        if (componentsToFetch[globalPatchesMeta['name']]) {
            ProcUtil.runSync(['git', 'fetch'], cancellable,
			     {cwd:mirrordir});
	}

        let gitMirrorArgs = ['ostbuild', 'git-mirror', '--manifest=' + args.manifest];
        if (args.fetch) {
            gitMirrorArgs.push('--fetch');
            if (args.fetch_keep_going) {
                gitMirrorArgs.push('-k');
	    }
            gitMirrorArgs.push.apply(gitMirrorArgs, args.components);
	}
        ProcUtil.runSync(gitMirrorArgs, cancellable);

        let patchRevision = Vcs.describeVersion(mirrordir, globalPatchesMeta['branch']);
        globalPatchesMeta['revision'] = patchRevision;

        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            let src = component['src'];
            let [keytype, uri] = Vcs.parseSrcKey(src);
            let branch = component['branch'];
            let tag = component['tag'];
            let branchOrTag = branch || tag;
            let mirrordir = Vcs.ensureVcsMirror(this._mirrordir, keytype, uri, branchOrTag, cancellable);
            let revision = Vcs.describeVersion(mirrordir, branchOrTag);
            component['revision'] = revision;
	}

	let snapshotdir = this.workdir.get_child('snapshots');
	this._src_db = new JsonDB.JsonDB(snapshotdir, this.prefix + '-src-snapshot');
        let [path, modified] = this._src_db.store(this._snapshot, cancellable);
        if (modified) {
            print("New source snapshot: " + path.get_path());
        } else {
            print("Source snapshot unchanged: " + path.get_path());
	}
    }
});

function main(argv) {
    let ecode = 1;
    var resolve = new Resolve();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
		  function() { try { resolve.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
