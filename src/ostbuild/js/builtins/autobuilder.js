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
const SubTask = imports.subtask;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Config = imports.config;

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

        this.parser.addArgument('--prefix');
        this.parser.addArgument('--autoupdate-self', { action: 'storeTrue' });
        this.parser.addArgument('--stage');

	this._stages = ['resolve', 'build', 'builddisks', 'smoke'];

	this._build_needed = true;
	this._do_builddisks = false;
	this._do_qa = false;
	this._full_resolve_needed = true;
	this._queued_force_resolve = [];
	this._resolve_timeout = 0;
	this._source_snapshot_path = null;
	this._prev_source_snapshot_path = null;
    },

    execute: function(args, loop, cancellable) {
	this._initSnapshot(args.prefix, null, cancellable);

	this._autoupdate_self = args.autoupdate_self;
	if (!args.stage)
	    args.stage = 'smoke';
	this._stageIndex = this._stages.indexOf(args.stage);
	if (this._stageIndex < 0)
	    throw new Error("Unknown stage " + args.stage);
	this._do_builddisks = this._stageIndex >= this._stages.indexOf('builddisks');
	this._do_smoke = this._stageIndex >= this._stages.indexOf('smoke');

	this._status_path = this.workdir.get_child('autobuilder-' + this.prefix + '.json');
	this._manifestPath = Gio.File.new_for_path('manifest.json');

	this._ownId = Gio.DBus.session.own_name('org.gnome.OSTreeBuild', Gio.BusNameOwnerFlags.NONE,
						function(name) {},
						function(name) { loop.quit(); });

	this._impl = Gio.DBusExportedObject.wrapJSObject(AutoBuilderIface, this);
	this._impl.export(Gio.DBus.session, '/org/gnome/OSTreeBuild/AutoBuilder');

	this._snapshot_dir = this.workdir.get_child('snapshots').get_child(this.prefix);
	this._src_db = new JsonDB.JsonDB(this._snapshot_dir);

	let taskdir = this.workdir.get_child('tasks');
	this._resolve_taskset = new SubTask.TaskSet(taskdir.get_child(this.prefix + '-resolve'));
	this._build_taskset = new SubTask.TaskSet(taskdir.get_child(this.prefix + '-build'));
	this._builddisks_taskset = new SubTask.TaskSet(taskdir.get_child(this.prefix + '-build-disks'));
	this._smoke_taskset = new SubTask.TaskSet(taskdir.get_child(this.prefix + '-smoke'));

	this._source_snapshot_path = this._src_db.getLatestPath();

	this._status_path = this.workdir.get_child('autobuilder-' + this.prefix + '.json');

	this._resolve_timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
							 60 * 10, Lang.bind(this, this._fetchAll));
	this._fetchAll();
	if (this._source_snapshot_path != null)
	    this._run_build();

	this._updateStatus();

	loop.run();
    },

    _updateStatus: function() {
	let newStatus = "";
	if (this._resolve_taskset.isRunning())
	    newStatus += "[resolving] ";
	if (this._build_taskset.isRunning())
	    newStatus += " [building] ";
	if (this._builddisks_taskset.isRunning())
	    newStatus += " [disks] ";
	if (newStatus == "")
	    newStatus = "[idle]";
	if (newStatus != this._status) {
	    this._status = newStatus;
	    print(this._status);
	    this._impl.emit_property_changed('Status', new GLib.Variant("s", this._status));
	}

	this._writeStatusFile();
    },

    get Status() {
	return this._status;
    },

    queueResolve: function(srcUrls) {
	let matchingComponents = [];
	let snapshotData = this._src_db.loadFromPath(this._source_snapshot_path, null);
	let snapshot = new Snapshot.Snapshot(snapshotData, this._source_snapshot_path);
	for (let i = 0; i < srcUrls.length; i++) {
	    let matches = snapshot.getMatchingSrc(srcUrls[i]);
	    for (let j = 0; j < matches.length; j++)
		matchingComponents.push(matches[j]['name']);
	}
	if (matchingComponents.length > 0) {
	    this._queued_force_resolve.push.apply(this._queued_force_resolve, matchingComponents);
	    print("queued resolves: " + matchingComponents.join(' '));
	    if (!this._resolve_taskset.isRunning())
		this._fetch();
	} else {
	    print("Ignored fetch requests for unknown URLs: " + srcUrls.join(','));
	}
    },
    
    _fetchAll: function() {
	this._full_resolve_needed = true;
	if (!this._resolve_taskset.isRunning())
	    this._fetch();
	return true;
    },

    _fetch: function() {
	let cancellable = null;

	if (this._autoupdate_self)
	    ProcUtil.runSync(['git', 'pull', '-r'], cancellable)

	let args = ['ostbuild', 'resolve', '--manifest=manifest.json',
		    '--fetch', '--fetch-keep-going'];
	let isFull;
	if (this._full_resolve_needed) {
	    this._full_resolve_needed = false;
	    isFull = true;
	} else if (this._queued_force_resolve.length > 0) {
	    args.push.apply(args, this._queued_force_resolve);
	    isFull = false;
	} else {
	    throw new Error("_fetch() when not needed");
	}
	this._queued_force_resolve = [];
	let context = new GSystem.SubprocessContext({ argv: args });
	let workdir = this._resolve_taskset.prepare();
	let tmpManifest = workdir.get_child(this._manifestPath.get_basename());
	GSystem.file_linkcopy(this._manifestPath, tmpManifest, Gio.FileCopyFlags.OVERWRITE, cancellable);	
	let t = this._resolve_taskset.start(context,
					    cancellable,
					    Lang.bind(this, this._onResolveExited));
	print(Format.vprintf("Resolve task %s started (%s)", [t.versionstr, isFull ? "full" : "incremental"]));

	this._updateStatus();

	return false;
    },

    _onResolveExited: function(resolveTask, success, msg) {
	print(Format.vprintf("resolve exited; success=%s msg=%s", [success, msg]))
	this._prev_source_snapshot_path = this._source_snapshot_path;
	this._source_snapshot_path = this._src_db.getLatestPath();
	let changed = (this._prev_source_snapshot_path == null ||
		       !this._prev_source_snapshot_path.equal(this._source_snapshot_path));
        if (changed)
            print(Format.vprintf("New version is %s", [this._source_snapshot_path.get_path()]))
	if (!this._build_needed)
	    this._build_needed = changed;
	if (this._build_needed && !this._build_taskset.isRunning())
	    this._run_build();

	if (this._full_resolve_needed || this._queued_force_resolve.length > 0) {
	    this._fetch();
	}

	this._updateStatus();
    },
    
    _run_build: function() {
	let cancellable = null;
	if (this._build_taskset.isRunning()) throw new Error();
	if (!this._build_needed) throw new Error();

	this._build_needed = false;

	let snapshotName = this._source_snapshot_path.get_basename();

	let workdir = this._build_taskset.prepare();
	let tmpSnapshotPath = workdir.get_child(snapshotName);
	GSystem.file_linkcopy(this._source_snapshot_path, tmpSnapshotPath,
			      Gio.FileCopyFlags.OVERWRITE, cancellable);	

	let version = this._src_db.parseVersionStr(this._source_snapshot_path.get_basename());
	let meta = {'version': version,
		    'version-path': this._snapshot_dir.get_relative_path(this._source_snapshot_path)};
	let metaPath = workdir.get_child('meta.json');
	JsonUtil.writeJsonFileAtomic(metaPath, meta, cancellable);
	
	let args = ['ostbuild', 'build', '--snapshot=' + snapshotName];

	let context = new GSystem.SubprocessContext({ argv: args });
	let task = this._build_taskset.start(context,
					     cancellable,
					     Lang.bind(this, this._onBuildExited));
	print(Format.vprintf("Build task %s started", [task.versionstr]));

	this._updateStatus();
    },

    _run_builddisks: function() {
	let cancellable = null;

	if (!this._do_builddisks || this._builddisks_taskset.isRunning())
	    return;

	let args = ['ostbuild', 'build-disks'];

	let context = new GSystem.SubprocessContext({ argv: args });
	let task = this._builddisks_taskset.start(context,
						  cancellable,
						  Lang.bind(this, this._onBuildDisksExited));
	print(Format.vprintf("Builddisks task %s started", [task.versionstr]));

	this._updateStatus();
    },

    _run_smoke: function() {
	let cancellable = null;

	if (!this._do_smoke || this._smoke_taskset.isRunning())
	    return;

	let args = ['ostbuild', 'qa-smoketest'];

	let context = new GSystem.SubprocessContext({ argv: args });
	let task = this._smoke_taskset.start(context,
					     cancellable,
					     Lang.bind(this, this._onSmokeExited));
	print(Format.vprintf("Smoke task %s started", [task.versionstr]));

	this._updateStatus();
    },

    _onBuildExited: function(buildTaskset, success, msg) {
	print(Format.vprintf("build exited; success=%s msg=%s", [success, msg]))
	if (this._build_needed)
	    this._run_build()
	if (success)
	    this._run_builddisks();
	
	this._updateStatus();
    },

    _onBuildDisksExited: function(buildTaskset, success, msg) {
	print(Format.vprintf("builddisks exited; success=%s msg=%s", [success, msg]))
	this._updateStatus();

	if (success)
	    this._run_smoke();

	this._updateStatus();
    },

    _getBuildDiffForTask: function(task) {
	let cancellable = null;
        if (task.build_diff != undefined)
            return task.build_diff;
        let metaPath = task.path.get_child('meta.json');
	if (!metaPath.query_exists(null)) {
	    task.build_diff = null;
	    return task.build_diff;
	}
	let meta = JsonUtil.loadJson(metaPath, cancellable);
        let snapshotPath = this._snapshot_dir.get_child(meta['version-path']);
        let prevSnapshotPath = this._src_db.getPreviousPath(snapshotPath);
        if (prevSnapshotPath == null) {
            task.build_diff = null;
        } else {
            task.build_diff = Snapshot.snapshotDiff(this._src_db.loadFromPath(snapshotPath, cancellable),
                                                    this._src_db.loadFromPath(prevSnapshotPath, cancellable));
	}
	return task.build_diff;
    },

    _buildHistoryToJson: function() {
	let cancellable = null;
        let history = this._build_taskset.getHistory();
	let l = history.length;
        let MAXITEMS = 5;
        let entries = [];
	for (let i = Math.max(l - MAXITEMS, 0); i >= 0 && i < l; i++) {
	    let item = history[i];
            let data = {v: item.versionstr,
			state: item.state,
			timestamp: item.timestamp};
            entries.push(data);
            let metaPath = item.path.get_child('meta.json');
            if (metaPath.query_exists(cancellable)) {
		data['meta'] = JsonUtil.loadJson(metaPath, cancellable);
	    }
            data['diff'] = this._getBuildDiffForTask(item);
	}
	return entries;
    },

    _writeStatusFile: function() {
	let cancellable = null;
        let status = {'prefix': this.prefix};
        if (this._source_snapshot_path != null) {
            let version = this._src_db.parseVersionStr(this._source_snapshot_path.get_basename());
            status['version'] = version;
            status['version-path'] = this._snapshot_dir.get_relative_path(this._source_snapshot_path);
        } else {
            status['version'] = '';
	}
        
        status['build'] = this._buildHistoryToJson();
        
        if (this._build_proc != null) {
	    let buildHistory = this._build_taskset.getHistory();
            let activeBuild = buildHistory[buildHistory.length-1];
	    let buildStatus = status['build'];
	    let activeBuildJson = buildStatus[buildStatus.length-1];
            let statusPath = activeBuild.path.get_child('status.json');
            if (statusPath.query_exists(null)) {
                activeBuildJson['build-status'] = JsonUtil.loadJson(statusPath);
	    }
	}
	
	JsonUtil.writeJsonFileAtomic(this._status_path, status, cancellable);
    }
});
