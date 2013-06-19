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
const Lang = imports.lang;

const JsonDB = imports.jsondb;
const Task = imports.task;

const TaskDummyResolve = new Lang.Class({
    Name: "TaskDummyResolve",
    Extends: Task.Task,

    TaskDef: {
        TaskName: "dummy-resolve",
    },

    DefaultParameters: {change: false},

    _getDb: function() {
	if (this._db == null) {
	    let snapshotdir = this.workdir.get_child('dummy-resolve');
	    this._db = new JsonDB.JsonDB(snapshotdir);
	}
	return this._db;
    },

    queryVersion: function() {
	return this._getDb().getLatestVersion();
    },

    execute: function(cancellable) {
	let change = this.parameters.change;
	let latest = this.queryVersion();
	if (!latest)
	    change = true;
	if (change) {
            let [path, modified] = this._getDb().store({timestamp: GLib.get_real_time() }, cancellable);
	}
    }
});
