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

const Task = imports.task;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Config = imports.config;

const loop = GLib.MainLoop.new(null, true);

var AutoBuilderIface = <interface name="org.gnome.OSTreeBuild.AutoBuilder">
<method name="queueBuild">
    <arg type="as" direction="in" />
</method>
<method name="queueResolve">
    <arg type="as" direction="in" />
</method>
<property name="Status" type="s" access="read" />
</interface>;

const AutoBuilder = new Lang.Class({
    Name: 'AutoBuilder',
    
    _init: function() {
	this._resolve_proc = null;
	this._build_proc = null;

	this.config = Config.get();
	this.workdir = Gio.File.new_for_path(this.config.getGlobal('workdir'));
	this.prefix = this.config.getPrefix();
	this._snapshot_dir = this.workdir.get_child('snapshots');
	this._status_path = this.workdir.get_child('autobuilder-' + this.prefix + '.json');

	this._build_needed = true;
	this._full_resolve_needed = true;
	this._queued_force_builds = [];
	this._queued_force_resolve = [];
	this._autoupdate_self = true;
	this._resolve_timeout = 0;
	this._source_snapshot_path = null;
	this._prev_source_snapshot_path = null;
	
	this._impl = Gio.DBusExportedObject.wrapJSObject(AutoBuilderIface, this);
	this._impl.export(Gio.DBus.session, '/org/gnome/OSTreeBuild/AutoBuilder');

	let snapshotdir = this.workdir.get_child('snapshots');
	GSystem.file_ensure_directory(snapshotdir, true, null);
	this._src_db = new JsonDB.JsonDB(snapshotdir, this.prefix + '-src-snapshot');

	let taskdir = new Task.TaskDir(this.workdir.get_child('tasks'));
	this._resolve_taskset = taskdir.get(this.prefix + '-resolve');
	this._build_taskset = taskdir.get(this.prefix + '-build');

	this._source_snapshot_path = this._src_db.getLatestPath();

	this._status_path = this.workdir.get_child('autobuilder-' + this.prefix + '.json');

	this._resolve_timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
							 60 * 10, Lang.bind(this, this._fetchAll));
	this._fetchAll();
	if (this._source_snapshot_path != null)
	    this._run_build();

	this._updateStatus();
    },

    _updateStatus: function() {
	let newStatus = "";
	if (this._resolve_proc == null && this._build_proc == null) {
	    newStatus = "idle";
	} else {
	    if (this._resolve_proc != null)
		newStatus += "[resolving] ";
	    if (this._build_proc != null)
		newStatus += "[building] ";
	}
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

    queueBuild: function(components) {
	this._queued_force_builds.push.apply(this._queued_force_builds, components);
	this._build_needed = true;
	print("queued builds: " + this._queued_force_builds);
	if (this._build_proc == null)
	    this._run_build();
    },

    queueResolve: function(components) {
	this._queued_force_resolve.push.apply(this._queued_force_resolve, components);
	print("queued resolves: " + this._queued_force_resolve);
	if (this._resolve_proc == null)
	    this._fetch();
    },
    
    _fetchAll: function() {
	this._full_resolve_needed = true;
	if (this._resolve_proc == null)
	    this._fetch();
	return true;
    },

    _fetch: function() {
	let cancellable = null;
	if (this._resolve_proc != null) throw new Error("Attempted multiple fetch");
	let t = this._resolve_taskset.start();
	let taskWorkdir = t.path;

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
	context.set_stdout_file_path(t.logfile_path.get_path());
	context.set_stderr_disposition(GSystem.SubprocessStreamDisposition.STDERR_MERGE);
	this._resolve_proc = new GSystem.Subprocess({context: context});
	this._resolve_proc.init(null);
	print(Format.vprintf("Resolve task %s.%s started (%s), pid=%s", [t.major, t.minor,
									 isFull ? "full" : "incremental",
									 this._resolve_proc.get_pid()]));
	this._resolve_proc.wait(null, Lang.bind(this, this._onResolveExited));

	this._updateStatus();

	return false;
    },

    _onResolveExited: function(process, result) {
	this._resolve_proc = null;
	let [success, msg] = ProcUtil.asyncWaitCheckFinish(process, result);
	print(Format.vprintf("resolve exited; success=%s msg=%s", [success, msg]))
	this._resolve_taskset.finish(success);
	this._prev_source_snapshot_path = this._source_snapshot_path;
	this._source_snapshot_path = this._src_db.getLatestPath();
	let changed = (this._prev_source_snapshot_path == null ||
		       !this._prev_source_snapshot_path.equal(this._source_snapshot_path));
        if (changed)
            print(Format.vprintf("New version is %s", [this._source_snapshot_path.get_path()]))
	if (!this._build_needed)
	    this._build_needed = changed;
	if (this._build_needed && this._build_proc == null)
	    this._run_build();

	if (this._full_resolve_needed || this._queued_force_resolve.length > 0) {
	    this._fetch();
	}

	this._updateStatus();
    },
    
    _run_build: function() {
	let cancellable = null;
	if (this._build_proc != null) throw new Error();
	if (!this._build_needed) throw new Error();

	this._build_needed = false;

	let task = this._build_taskset.start();
	let workdir = task.path;
	let transientSnapshotPath = workdir.get_child(this._source_snapshot_path.get_basename());
	GSystem.file_linkcopy(this._source_snapshot_path, transientSnapshotPath, Gio.FileCopyFlags.OVERWRITE, null);
	let args = ['ostbuild', 'build', '--snapshot=' + transientSnapshotPath.get_path()];
	args.push.apply(args, this._queued_force_builds);
	this._queued_force_builds = [];

	let version = this._src_db.parseVersionStr(this._source_snapshot_path.get_basename());
	let meta = {'version': version,
		    'version-path': this._snapshot_dir.get_relative_path(this._source_snapshot_path)};
	let metaPath = workdir.get_child('meta.json');
	JsonUtil.writeJsonFileAtomic(metaPath, meta, cancellable);

	let context = new GSystem.SubprocessContext({ argv: args });
	context.set_stdout_file_path(task.logfile_path.get_path());
	context.set_stderr_disposition(GSystem.SubprocessStreamDisposition.STDERR_MERGE);
	this._build_proc = new GSystem.Subprocess({context: context});
	this._build_proc.init(null);
	print(Format.vprintf("Build task %s.%s started, pid=%s", [task.major, task.minor, this._build_proc.get_pid()]));
	this._build_proc.wait(null, Lang.bind(this, this._onBuildExited));

	this._updateStatus();
    },

    _onBuildExited: function(process, result) {
	if (this._build_proc == null) throw new Error();
	this._build_proc = null;
	let [success, msg] = ProcUtil.asyncWaitCheckFinish(process, result);
	print(Format.vprintf("build exited; success=%s msg=%s", [success, msg]))
	this._build_taskset.finish(success);
	if (this._build_needed)
	    this._run_build()
	
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
            let data = {v: Format.vprintf('%d.%d', [item.major, item.minor]),
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

function main(argv) {
    var ownId = Gio.DBus.session.own_name('org.gnome.OSTreeBuild', Gio.BusNameOwnerFlags.NONE,
					  function(name) {},
					  function(name) { loop.quit(); });
    
    var builder = new AutoBuilder();
    loop.run();
}
