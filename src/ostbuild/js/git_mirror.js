// Copyright (C) 2011,2012 Colin Walters <walters@verbum.org>
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

const ProcUtil = imports.procutil;
const Config = imports.config;
const Snapshot = imports.snapshot;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const JsonUtil = imports.jsonutil;
const JsonDB = imports.jsondb;
const ArgParse = imports.argparse;

var loop = GLib.MainLoop.new(null, true);

const GitMirror = new Lang.Class({
    Name: 'GitMirror',
    
    _init: function() {

    },

    execute: function(argv) {
	let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Update internal git mirror for one or more components");
        parser.addArgument('--prefix');
        parser.addArgument('--manifest');
        parser.addArgument('--src-snapshot');
        parser.addArgument('--fetch', {action:'storeTrue',
				       help:"Also do a git fetch for components"});
        parser.addArgument(['-k', '--keep-going'], {action:'storeTrue',
						    help: "Don't exit on fetch failures"});
        parser.addArgument('components', {nargs:'*'});

        let args = parser.parse(argv);

	this.config = Config.get();
	this.workdir = Gio.File.new_for_path(this.config.getGlobal('workdir'));
	this._mirrordir = Gio.File.new_for_path(this.config.getGlobal('mirrordir'));
	this.prefix = args.prefix || this.config.getPrefix();
	this._snapshotDir = this.workdir.get_child('snapshots');
	this._srcDb = new JsonDB.JsonDB(this._snapshotDir, this.prefix + '-src-snapshot');

        if (args.manifest != null) {
            this._snapshot = JsonUtil.loadJson(Gio.File.new_for_path(args.manifest), cancellable);
	    let resolvedComponents = [];
	    let components = this._snapshot['components'];
	    for (let i = 0; i < components.length; i++) {
		resolvedComponents.push(BuildUtil.resolveComponent(this._snapshot, components[i]));
	    }
            this._snapshot['components'] = resolvedComponents;
            this._snapshot['patches'] = BuildUtil.resolveComponent(this._snapshot, this._snapshot['patches']);
        } else {
	    [this._snapshot, this._snapshotPath] = Snapshot.load(this._srcDb, this.prefix, args.snapshot, cancellable);
	}

	let componentNames;
        if (args.components.length == 0) {
            componentNames = [];
	    this._snapshot['components'].forEach(function (component) {
		componentNames.push(component['name']);
	    });
            componentNames.push(this._snapshot['patches']['name']);
        } else {
            componentNames = args.components;
	}

	componentNames.forEach(Lang.bind(this, function (name) {
            let component = Snapshot.getComponent(this._snapshot, name);
            let src = component['src']
            let [keytype, uri] = Vcs.parseSrcKey(src);
            let branch = component['branch'];
            let tag = component['tag'];
            let branchOrTag = branch || tag;

            if (!args.fetch) {
                Vcs.ensureVcsMirror(this._mirrordir, keytype, uri, branchOrTag, cancellable);
	    } else {
		print("Running git fetch for " + name);
		Vcs.fetch(this._mirrordir, keytype, uri, branchOrTag, cancellable, {keepGoing:args.keep_going});
	    }
	}));
    }
});

function main(argv) {
    let ecode = 1;
    var gitMirror = new GitMirror();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
		  function() { try { gitMirror.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
