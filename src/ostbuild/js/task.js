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
const format = imports.format;
const Lang = imports.lang;
const Signals = imports.signals;

const GSystem = imports.gi.GSystem;
const Config = imports.config;
const Params = imports.params;
const JsonUtil = imports.jsonutil;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const BuildUtil = imports.buildutil;

var _tasksetInstance = null;
const TaskSet = new Lang.Class({
    Name: 'TaskSet',
    
    _init: function() {
	this._tasks = [];
	let taskdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_DATADIR')).resolve_relative_path('js/tasks');
	let denum = taskdir.enumerate_children('standard::*', 0, null);
	let finfo;
	
	for (let taskmodname in imports.tasks) {
	    let taskMod = imports.tasks[taskmodname];
	    for (let defname in taskMod) {
		if (defname.indexOf('Task') !== 0
		    || defname == 'Task')
		    continue;
		let cls = taskMod[defname];
		this.register(cls);
	    }
	}
    },

    register: function(taskdef) {
	this._tasks.push(taskdef);
    },

    getAllTasks: function() {
	return this._tasks;
    },

    getTask: function(taskName, params) {
	params = Params.parse(params, { allowNone: false })
	for (let i = 0; i < this._tasks.length; i++) {
	    let taskDef = this._tasks[i];
            let pattern = taskDef.prototype.TaskPattern;
            let re = pattern[0];
            let match = re.exec(taskName);
            if (!match)
		continue;
            let vars = {};
            for (let i = 1; i < pattern.length; i++) {
		vars[pattern[i]] = match[i];
            }
	    return [taskDef, vars];
	}
	if (!params.allowNone)
	    throw new Error("No task definition matches " + taskName);
	return null;
    },

    getInstance: function() {
	if (!_tasksetInstance)
	    _tasksetInstance = new TaskSet();
	return _tasksetInstance;
    }
});
    
const TaskMaster = new Lang.Class({
    Name: 'TaskMaster',

    _init: function(path, params) {
	params = Params.parse(params, {onEmpty: null});
	this.path = path;
	this.maxConcurrent = GLib.get_num_processors();
	this._onEmpty = params.onEmpty;
	this.cancellable = null;
	this._idleRecalculateId = 0;
	this._executing = [];
	this._pendingTasksList = [];
	this._seenTasks = {};
	this._taskErrors = {};
	this._caughtError = false;

	this._taskset = TaskSet.prototype.getInstance();
    },

    pushTask: function(taskName, parameters) {
	let [taskDef, vars] = this._taskset.getTask(taskName);
	let instance = new taskDef(this, taskName, vars, parameters);
	instance.onComplete = Lang.bind(this, this._onComplete, instance);
	this._pendingTasksList.push(instance);
	this._queueRecalculate();
    },

    isTaskQueued: function(taskName) {
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let pending = this._pendingTasksList[i];
	    if (pending.name == taskName)
		return true;
	}
	return this.isTaskExecuting(taskName);
    },

    isTaskExecuting: function(taskName) {
	for (let i = 0; i < this._executing.length; i++) {
	    let executingTask = this._executing[i];
	    if (executingTask.name == taskName)
		return true;
	}
	return false;
    },

    getTaskState: function() {
	let r = [];
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    r.push({running: false, task: this._pendingTasksList[i] });
	}
	for (let i = 0; i < this._executing.length; i++) {
	    r.push({running: true, task: this._executing[i] });
	}
	return r;
    },

    _queueRecalculate: function() {
	if (this._idleRecalculateId > 0)
	    return;
	this._idleRecalculateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this, this._recalculate));
    },

    _recalculate: function() {
	this._idleRecalculateId = 0;

	if (this._executing.length == 0 &&
	    this._pendingTasksList.length == 0) {
	    this._onEmpty(true, null);
	    return;
	} else if (this._pendingTasksList.length == 0) {
	    return;
	}

	this._reschedule();
    },

    _onComplete: function(success, error, task) {
	this.emit('task-complete', task, success, error);
	let idx = -1;
	for (let i = 0; i < this._executing.length; i++) {
	    let executingTask = this._executing[i];
	    if (executingTask !== task)
		continue;
	    idx = i;
	    break;
	}
	if (idx == -1)
	    throw new Error("TaskMaster: Internal error - Failed to find completed task:" + task.TaskName);
	this._executing.splice(idx, 1);
	this._queueRecalculate();
    },

    _reschedule: function() {
	while (this._executing.length < this.maxConcurrent &&
	       this._pendingTasksList.length > 0 &&
	       !this.isTaskExecuting(this._pendingTasksList[0].name)) {
	    let task = this._pendingTasksList.shift();
	    task._executeInSubprocessInternal(this.cancellable);
	    this._executing.push(task);
	}
    }
});
Signals.addSignalMethods(TaskMaster.prototype);

const TaskDef = new Lang.Class({
    Name: 'TaskDef',

    TaskPattern: null,

    PreserveStdout: true,
    RetainFailed: 1,
    RetainSuccess: 5,

    DefaultParameters: {},

    _VERSION_RE: /^(\d+\d\d\d\d)\.(\d+)$/,

    _init: function(taskmaster, name, vars, parameters) {
	this.taskmaster = taskmaster;
	this.name = name;
	this.vars = vars;
	this.parameters = Params.parse(parameters, this.DefaultParameters);

	this.config = Config.get();
	this.workdir = Gio.File.new_for_path(this.config.getGlobal('workdir'));
	this.resultdir = this.workdir.get_child('results');
	this.mirrordir = Gio.File.new_for_path(this.config.getGlobal('mirrordir'));
	this.libdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_LIBDIR'));
	this.repo = this.workdir.get_child('repo');
    },

    getDepends: function() {
	return [];
    },

    _getResultDb: function(taskname) {
	let path = this.resultdir.resolve_relative_path(taskname);
	return new JsonDB.JsonDB(path);
    },

    _loadVersionsFrom: function(dir, cancellable) {
	let e = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	let info;
	let results = [];
	while ((info = e.next_file(cancellable)) != null) {
	    let name = info.get_name();
	    let match = this._VERSION_RE.exec(name);
	    if (!match)
		continue;
	    results.push(name);
	}
	results.sort(BuildUtil.compareVersions);
	return results;
    },

    _cleanOldVersions: function(dir, retain, cancellable) {
	let versions = this._loadVersionsFrom(dir, cancellable);
	while (versions.length > retain) {
	    let child = dir.get_child(versions.shift());
	    GSystem.shutil_rm_rf(child, cancellable);
	}
    },

    execute: function(cancellable) {
	throw new Error("Not implemented");
    },

    _loadAllVersions: function(cancellable) {
	let allVersions = [];

	let successVersions = this._loadVersionsFrom(this._successDir, cancellable);
	for (let i = 0; i < successVersions.length; i++) {
	    allVersions.push([true, successVersions[i]]);
	}

	let failedVersions = this._loadVersionsFrom(this._failedDir, cancellable);
	for (let i = 0; i < failedVersions.length; i++) {
	    allVersions.push([false, failedVersions[i]]);
	}

	allVersions.sort(function (a, b) {
	    let [successA, versionA] = a;
	    let [successB, versionB] = b;
	    return BuildUtil.compareVersions(versionA, versionB);
	});

	return allVersions;
    },

    _executeInSubprocessInternal: function(cancellable) {
	this._cancellable = cancellable;

	this._startTimeMillis = GLib.get_monotonic_time() / 1000;

	this.dir = this.taskmaster.path.resolve_relative_path(this.name);
	GSystem.file_ensure_directory(this.dir, true, cancellable);
	
	this._successDir = this.dir.get_child('successful');
	GSystem.file_ensure_directory(this._successDir, true, cancellable);
	this._failedDir = this.dir.get_child('failed');
	GSystem.file_ensure_directory(this._failedDir, true, cancellable);

	let allVersions = this._loadAllVersions(cancellable);

	let currentTime = GLib.DateTime.new_now_utc();

	let currentYmd = Format.vprintf('%d%02d%02d', [currentTime.get_year(),
						       currentTime.get_month(),
						       currentTime.get_day_of_month()]);
	let version = null;
	if (allVersions.length > 0) {
	    let [lastSuccess, lastVersion] = allVersions[allVersions.length-1];
	    let match = this._VERSION_RE.exec(lastVersion);
	    if (!match) throw new Error();
	    let lastYmd = match[1];
	    let lastSerial = match[2];
	    if (lastYmd == currentYmd) {
		version = currentYmd + '.' + (parseInt(lastSerial) + 1);
	    }
	}
	if (version === null) {
	    version = currentYmd + '.0';
	}

	this._version = version;
	this._workdir = this.dir.get_child(version);
	GSystem.shutil_rm_rf(this._workdir, cancellable);
	GSystem.file_ensure_directory(this._workdir, true, cancellable);

	let baseArgv = ['ostbuild', 'run-task', this.name, JSON.stringify(this.parameters)];
	let context = new GSystem.SubprocessContext({ argv: baseArgv });
	context.set_cwd(this._workdir.get_path());
	context.set_stdin_disposition(GSystem.SubprocessStreamDisposition.PIPE);
	if (this.PreserveStdout) {
	    let outPath = this._workdir.get_child('output.txt');
	    context.set_stdout_file_path(outPath.get_path());
	    context.set_stderr_disposition(GSystem.SubprocessStreamDisposition.STDERR_MERGE);
	} else {
	    context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.NULL);
	    let errPath = this._workdir.get_child('errors.txt');
	    context.set_stderr_file_path(errPath.get_path());
	}
	this._proc = new GSystem.Subprocess({ context: context });
	this._proc.init(cancellable);

	this._proc.wait(cancellable, Lang.bind(this, this._onChildExited));
    },

    _updateIndex: function(cancellable) {
	let allVersions = this._loadAllVersions(cancellable);

	let fileList = [];
	for (let i = 0; i < allVersions.length; i++) {
	    let [successful, version] = allVersions[i];
	    let fname = (successful ? 'successful/' : 'failed/') + version;
	    fileList.push(fname);
	}

	let index = { files: fileList };
	JsonUtil.writeJsonFileAtomic(this.dir.get_child('index.json'), index, cancellable);
    },
    
    _onChildExited: function(proc, result) {
	let cancellable = this._cancellable;
	let [success, errmsg] = ProcUtil.asyncWaitCheckFinish(proc, result);
	let target;

	let elapsedMillis = GLib.get_monotonic_time() / 1000 - this._startTimeMillis;
	let meta = { taskMetaVersion: 0,
		     taskVersion: this._version,
		     success: success,
		     errmsg: errmsg,
		     elapsedMillis: elapsedMillis };
	JsonUtil.writeJsonFileAtomic(this._workdir.get_child('meta.json'), meta, cancellable);

	if (!success) {
	    target = this._failedDir.get_child(this._version);
	    GSystem.file_rename(this._workdir, target, null);
	    this._workdir = target;
	    this._cleanOldVersions(this._failedDir, this.RetainFailed, null);
	    this.onComplete(success, errmsg);
	} else {
	    target = this._successDir.get_child(this._version);
	    GSystem.file_rename(this._workdir, target, null);
	    this._workdir = target;
	    this._cleanOldVersions(this._successDir, this.RetainSuccess, null);
	    this.onComplete(success, null);
	}
	// Also remove any old interrupted versions
	this._cleanOldVersions(this.dir, 0, null);

	this._updateIndex(cancellable);

	BuildUtil.atomicSymlinkSwap(this.dir.get_child('current'), target, cancellable);
    }
});
