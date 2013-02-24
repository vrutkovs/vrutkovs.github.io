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

	this._stages = ['resolve', 'build', 'builddisks', 'smoke'];

	this._buildNeeded = true;
	this._fullResolveNeeded = true;
	this._resolveTimeout = 0;
	this._sourceSnapshotPath = null;
	this._prevSourceSnapshotPath = null;
	this._queuedForceResolve = [];
    },

    execute: function(args, loop, cancellable) {
	this._initSnapshot(null, null, cancellable);

	this._autoupdate_self = args.autoupdate_self;
	if (!args.stage)
	    args.stage = 'build';
	this._stageIndex = this._stages.indexOf(args.stage);
	if (this._stageIndex < 0)
	    throw new Error("Unknown stage " + args.stage);
	this._do_builddisks = this._stageIndex >= this._stages.indexOf('builddisks');
	this._do_smoke = this._stageIndex >= this._stages.indexOf('smoke');

	this._resolveTaskName = 'resolve'
	this._buildTaskName = 'build'
	this._bdiffTaskName = 'bdiff';

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
	this._taskmaster.connect('task-complete', Lang.bind(this, this._onTaskCompleted));

	this._sourceSnapshotPath = this._src_db.getLatestPath();

	this._resolveTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
							 60 * 10, Lang.bind(this, this._triggerFullResolve));
	this._runResolve();
	if (this._sourceSnapshotPath != null)
	    this._runBuild();

	this._updateStatus();

	loop.run();
    },

    _onTasksComplete: function() {
    },

    _onTaskCompleted: function(taskmaster, task, success, error) {
	if (task.name == this._resolveTaskName) {
	    this._onResolveExited(task, success, error);
	} else if (task.name == this._buildTaskName) {
	    this._onBuildExited(task, success, error);
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
	
	if (!(this._queuedForceResolve.length > 0 || this._fullResolveNeeded))
	    return;

	if (this._taskmaster.isTaskQueued(this._resolveTaskName))
	    return;

	if (this._autoupdate_self)
	    ProcUtil.runSync(['git', 'pull', '-r'], cancellable)

	if (this._fullResolveNeeded) {
	    this._fullResolveNeeded = false;
	    this._taskmaster.pushTask(this._resolveTaskName,
				      { fetchAll: true });
	} else {
	    this._taskmaster.pushTask(this._resolveTaskName,
				      { fetchComponents: this._queuedForceResolve });
	}
	this._queuedForceResolve = [];

	this._updateStatus();
    },

    _onResolveExited: function(resolveTask, success, msg) {
	print(Format.vprintf("resolve exited; success=%s msg=%s", [success, msg]))
	this._prevSourceSnapshotPath = this._sourceSnapshotPath;
	this._sourceSnapshotPath = this._src_db.getLatestPath();
	let changed = (this._prevSourceSnapshotPath == null ||
		       !this._prevSourceSnapshotPath.equal(this._sourceSnapshotPath));
        if (changed)
            print(Format.vprintf("New version is %s", [this._sourceSnapshotPath.get_path()]))
	if (!this._buildNeeded)
	    this._buildNeeded = changed;
	this._runBuild();
	this._runResolve();
	this._updateStatus();
    },

    _onBuildExited: function(buildTaskset, success, msg) {
       print(Format.vprintf("build exited; success=%s msg=%s", [success, msg]))
       if (this._buildNeeded)
           this._runBuild()
       
       this._updateStatus();
    },
    
    _runBuild: function() {
	let cancellable = null;
	if (this._taskmaster.isTaskQueued(this._buildTaskName))
	    return;
	if (!this._buildNeeded)
	    return;

	this._buildNeeded = false;
	this._taskmaster.pushTask(this._buildTaskName);
	this._updateStatus();
    },

    _runBdiff: function() {
	if (this._taskmaster.isTaskQueued(this._bdiffTaskName))
	    return;

	this._taskmaster.pushTask(this._bdiffTaskName);
	this._updateStatus();
    }
});
