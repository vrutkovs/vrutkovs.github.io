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
const Task = imports.task;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;

const loop = GLib.MainLoop.new(null, true);

var AutoBuilderIface = <interface name="org.gnome.OSTreeBuild.AutoBuilder">
<method name="queueResolve">
    <arg type="as" direction="in" />
</method>
<property name="Status" type="s" access="read" />
</interface>;

const Autobuilder = new Lang.Class({
    Name: 'Autobuilder',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Automatically fetch git repositories and build",
    
    _init: function() {
	this.parent();

        this.parser.addArgument('--autoupdate-self', { action: 'storeTrue' });
        this.parser.addArgument('--stage');

	this._buildNeeded = true;
	this._initialResolveNeeded = true;
	this._fullResolveNeeded = true;
	this._resolveTimeout = 0;
	this._sourceSnapshotPath = null;
	this._prevSourceSnapshotPath = null;
	this._queuedForceResolve = [];
    },

    execute: function(args, loop, cancellable) {
	this._initSnapshot(null, null, cancellable);

	this._autoupdate_self = args.autoupdate_self;

	this._manifestPath = Gio.File.new_for_path('manifest.json');

	this._ownId = Gio.DBus.session.own_name('org.gnome.OSTreeBuild', Gio.BusNameOwnerFlags.NONE,
						function(name) {},
						function(name) { loop.quit(); });

	this._impl = Gio.DBusExportedObject.wrapJSObject(AutoBuilderIface, this);
	this._impl.export(Gio.DBus.session, '/org/gnome/OSTreeBuild/AutoBuilder');

	this._snapshot_dir = this.workdir.get_child('snapshots');
	this._src_db = new JsonDB.JsonDB(this._snapshot_dir);

	this._taskmaster = new Task.TaskMaster(this.workdir.get_child('tasks'),
						  { onEmpty: Lang.bind(this, this._onTasksComplete) });
	this._taskmaster.connect('task-executing', Lang.bind(this, this._onTaskExecuting));
	this._taskmaster.connect('task-complete', Lang.bind(this, this._onTaskCompleted));

	this._sourceSnapshotPath = this._src_db.getLatestPath();

	/* Start an initial, non-fetching resolve */
	this._runResolve();
	/* Flag immediately that we need a full resolve */
	this._fullResolveNeeded = true;
	/* And set a timeout for 10 minutes for the next full resolve */
	this._resolveTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
							 60 * 10, Lang.bind(this, this._triggerFullResolve));

	this._updateStatus();

	loop.run();
    },

    _onTasksComplete: function() {
    },

    _onTaskExecuting: function(taskmaster, task) {
	let workdir = task._workdir;
	print("Task " + task.name + " executing in " + workdir.get_path());
	this._updateStatus();
    },

    _onTaskCompleted: function(taskmaster, task, success, error) {
	if (task.name == 'resolve')
	    this._runResolve();
	if (success) {
	    print("Task " + task.name + " complete: " + task._workdir.get_path());
	} else {
	    this._failed = true;
	    print("Task " + task.name + " failed: " + task._workdir.get_path());
	}
	this._updateStatus();
    },

    _updateStatus: function() {
	let newStatus = "";
	let taskstateList = this._taskmaster.getTaskState();
	for (let i = 0; i < taskstateList.length; i++) {
	    let taskstate = taskstateList[i];
	    newStatus += (taskstate.task.name + " ");
	}
	if (newStatus == "")
	    newStatus = "[idle]";
	if (newStatus != this._status) {
	    this._status = newStatus;
	    print(this._status);
	    this._impl.emit_property_changed('Status', new GLib.Variant("s", this._status));
	}
    },

    get Status() {
	return this._status;
    },

    queueResolve: function(srcUrls) {
	let matchingComponents = [];
	let snapshotData = this._src_db.loadFromPath(this._sourceSnapshotPath, null);
	let snapshot = new Snapshot.Snapshot(snapshotData, this._sourceSnapshotPath);
	for (let i = 0; i < srcUrls.length; i++) {
	    let matches = snapshot.getMatchingSrc(srcUrls[i]);
	    for (let j = 0; j < matches.length; j++) {
		let name = matches[i]['name'];
		this._queuedForceResolve.push.apply(this._queuedForceResolve, name);
		print("Queued force resolve for " + name);
	    }
	}
	this._runResolve();
    },
    
    _triggerFullResolve: function() {
	this._fullResolveNeeded = true;
	this._runResolve();
	return true;
    },

    _runResolve: function() {
	let cancellable = null;
	
	if (!(this._initialResolveNeeded ||
	      this._queuedForceResolve.length > 0 ||
	      this._fullResolveNeeded))
	    return;

	if (this._taskmaster.isTaskQueued('resolve'))
	    return;

	if (this._autoupdate_self)
	    ProcUtil.runSync(['git', 'pull', '-r'], cancellable)

	if (this._initialResolveNeeded) {
	    this._initialResolveNeeded = false;
	    this._taskmaster.pushTask('resolve', { });
	} else if (this._fullResolveNeeded) {
	    this._fullResolveNeeded = false;
	    this._taskmaster.pushTask('resolve', { fetchAll: true });
	} else {
	    this._taskmaster.pushTask('resolve', { fetchComponents: this._queuedForceResolve });
	}
	this._queuedForceResolve = [];

	this._updateStatus();
    }
});
