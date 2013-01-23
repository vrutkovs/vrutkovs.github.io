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

const Builtin = imports.builtin;
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
    Extends: Builtin.Builtin,

    DESCRIPTION: "Update internal git mirror for one or more components",
    
    _init: function() {
	this.parent();
        this.parser.addArgument('--prefix');
        this.parser.addArgument('--manifest');
        this.parser.addArgument('--snapshot');
        this.parser.addArgument('--fetch', {action:'storeTrue',
				       help:"Also do a git fetch for components"});
        this.parser.addArgument(['-k', '--keep-going'], {action:'storeTrue',
						    help: "Don't exit on fetch failures"});
        this.parser.addArgument('components', {nargs:'*'});
    },

    execute: function(args, loop, cancellable) {
        let parser = new ArgParse.ArgumentParser();

        if (args.manifest != null) {
            let snapshotData = JsonUtil.loadJson(Gio.File.new_for_path(args.manifest), cancellable);
	    let resolvedComponents = [];
	    let components = snapshotData['components'];
	    for (let i = 0; i < components.length; i++) {
		resolvedComponents.push(BuildUtil.resolveComponent(snapshotData, components[i]));
	    }
            snapshotData['components'] = resolvedComponents;
            snapshotData['patches'] = BuildUtil.resolveComponent(snapshotData, snapshotData['patches']);
            snapshotData['base'] = BuildUtil.resolveComponent(snapshotData, snapshotData['base']);
	    this._snapshot = new Snapshot.Snapshot(snapshotData, null);
        } else {
	    this._initSnapshot(args.prefix, args.snapshot, cancellable);
	}

	let componentNames;
        if (args.components.length == 0) {
	    componentNames = this._snapshot.getAllComponentNames();
        } else {
            componentNames = args.components;
	}

	componentNames.forEach(Lang.bind(this, function (name) {
            let component = this._snapshot.getComponent(name);
            let src = component['src']
            let [keytype, uri] = Vcs.parseSrcKey(src);
            let branch = component['branch'];
            let tag = component['tag'];
            let branchOrTag = branch || tag;

            if (!args.fetch) {
                Vcs.ensureVcsMirror(this.mirrordir, keytype, uri, branchOrTag, cancellable);
	    } else {
		print("Running git fetch for " + name);
		Vcs.fetch(this.mirrordir, keytype, uri, branchOrTag, cancellable, {keepGoing:args.keep_going});
	    }
	}));
    }
});
