// Copyright (C) 2012,2013 Colin Walters <walters@verbum.org>
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

const Builtin = imports.builtin;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Params = imports.params;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

function _checkoutOneComponent(mirrordir, patchdir, component, cancellable, params) {
    params = Params.parse(params, { checkoutdir: null,
				    clean: false,
				    patchesPath: null,
				    overwrite: false });
    let [keytype, uri] = BuildUtil.parseSrcKey(component['src']);

    let isLocal = (keytype == 'local');

    let checkoutdir;
    if (isLocal) {
	if (params.checkoutdir != null) {
	    checkoutdir = Gio.File.new_for_path(params.checkoutdir);
	    let ftype = checkoutdir.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	    // Kind of a hack, but...
	    if (ftype == Gio.FileType.SYMBOLIC_LINK)
		GSystem.file_unlink(checkoutdir, cancellable);
	    if (params.overwrite && ftype == Gio.FileType.DIRECTORY)
		GSystem.shutil_rm_rf(checkoutdir, cancellable);
	    
	    checkoutdir.make_symbolic_link(uri, cancellable);
	} else {
	    checkoutdir = Gio.File.new_for_path(uri);
	}
    } else {
	if (params.checkoutdir) {
	    checkoutdir = Gio.File.new_for_path(params.checkoutdir);
	} else {
	    checkoutdir = Gio.File.new_for_path(component['name']);
	    GSystem.file_ensure_directory(checkoutdir.get_parent(), true, cancellable);
	}
	Vcs.getVcsCheckout(mirrordir, keytype, uri, checkoutdir,
			   component['revision'], cancellable,
			   { overwrite: params.overwrite });
    }

    if (params.clean) {
	if (isLocal) {
	    print("note: ignoring --clean argument due to \"local:\" specification");
	} else {
	    Vcs.clean(keytype, checkoutdir, cancellable);
	}
    }

    if (component['patches']) {
	let usePatchdir;
	if (params.patchesPath == null) {
	    usePatchdir = Vcs.checkoutPatches(mirrordir, patchdir, component, cancellable);
	} else {
	    usePatchdir = Gio.File.new_for_path(params.patchesPath);
	}
	let patches = BuildUtil.getPatchPathsForComponent(usePatchdir, component)
	for (let i = 0; i < patches.length; i++) {
	    let patch = patches[i];
	    ProcUtil.runSync(['git', 'am', '--ignore-date', '-3', patch.get_path()], cancellable,
			     {cwd:checkoutdir});
	}
    }

    let metadataPath = checkoutdir.get_child('_ostbuild-meta.json');
    JsonUtil.writeJsonFileAtomic(metadataPath, component, cancellable);

    print("Checked out " + component['name'] + " at " + component['revision'] + " in " + checkoutdir.get_path());
}

const Checkout = new Lang.Class({
    Name: 'Checkout',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Check out git repository",

    _init: function() {
	this.parent();
	this.parser.addArgument('--overwrite', {action:'storeTrue'});
	this.parser.addArgument('--patches-path');
	this.parser.addArgument('--metadata-path');
	this.parser.addArgument('--workdir');
	this.parser.addArgument('--snapshot');
	this.parser.addArgument('--checkoutdir');
	this.parser.addArgument('--clean', {action: 'storeTrue'});
	this.parser.addArgument('component');
    },

    execute: function(args, loop, cancellable) {
	this._initSnapshot(args.workdir, args.snapshot, cancellable);

        let componentName = args.component;

	if (componentName != '*') {
	    let component;
            if (args.metadata_path != null) {
		component = JsonUtil.loadJson(Gio.File.new_for_path(args.metadata_path), cancellable);
            } else {
		component = this._snapshot.getExpanded(componentName);
	    }

	    _checkoutOneComponent(this.mirrordir, this.patchdir, component, cancellable,
				  { checkoutdir: args.checkoutdir,
				    clean: args.clean,
				    patchesPath: args.patches_path,
				    overwrite: args.overwrite });
	} else {
	    let all = this._snapshot.getAllComponentNames();
	    for (let i = 0; i < all.length; i++) {
		let component = this._snapshot.getExpanded(all[i]);
		_checkoutOneComponent(this.mirrordir, this.patchdir, component, cancellable,
				      { checkoutdir: args.checkoutdir,
					clean: args.clean,
					patchesPath: args.patches_path,
					overwrite: args.overwrite });
	    }
	}
    }
});
