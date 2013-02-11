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

const Config = imports.config;
const Params = imports.params;
const JsonUtil = imports.jsonutil;
const ArgParse = imports.argparse;
const JsonDB = imports.jsondb;
const Snapshot = imports.snapshot;

const Builtin = new Lang.Class({
    Name: 'Builtin',

    DESCRIPTION: null,

    _init: function() {
	this.parser = new ArgParse.ArgumentParser(this.DESCRIPTION);
        
	this.config = Config.get();
	this.workdir = Gio.File.parse_name(this.config.getGlobal('workdir'));
	this.mirrordir = Gio.File.parse_name(this.config.getGlobal('mirrordir'));
	this.patchdir = this.workdir.get_child('patches');
	this.libdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_LIBDIR'));
	this.repo = this.workdir.get_child('repo');
    },

    _initPrefix: function(prefix) {
	if (!prefix)
	    this.prefix = Config.get().getPrefix();
	else
	    this.prefix = prefix;
    },

    _initSnapshot: function(prefix, snapshotPath, cancellable) {
	let snapshotDir = this.workdir.get_child('snapshots');
	let path, data;
	if (!prefix && !snapshotPath)
	    prefix = Config.get().getPrefix();
	if (prefix) {
	    this.prefix = prefix;
	    let db = new JsonDB.JsonDB(snapshotDir.get_child(prefix));
	    path = db.getLatestPath();
	    data = db.loadFromPath(path, cancellable);
	} else {
	    path = Gio.File.new_for_path(snapshotPath);
	    data = JsonUtil.loadJson(path, cancellable);
	    this.prefix = data['prefix'];
	}
	this._snapshot = new Snapshot.Snapshot(data, path);
    },

    main: function(argv, loop, cancellable) {
	let args = this.parser.parse(argv);
	this.execute(args, loop, cancellable);
    }
});
