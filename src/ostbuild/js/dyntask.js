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

const GSystem = imports.gi.GSystem;
const Params = imports.params;

const VERSION_RE = /(\d+)\.(\d+)/;

const TaskMaster = new Lang.Class({
    Name: 'TaskMaster',

    _init: function(path, params) {
	params = Params.parse(params, {maxConcurrent: 4,
				       onEmpty: null});
	this.path = path;
	this.maxConcurrent = params.maxConcurrent;
	this._onEmpty = params.onEmpty;
	this.cancellable = null;
	this._idleRecalculateId = 0;
	this._taskSerial = 1;
	this._tasks = [];
	this._executing = [];
	this._pendingTasksList = [];
	this._seenTasks = {};
	this._completeTasks = {};
	this._taskErrors = {};

	let taskdir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_DATADIR')).resolve_relative_path('js/tasks');
	let denum = taskdir.enumerate_children('standard::*', 0, null);
	let finfo;
	
	for (let taskname in imports.tasks) {
	    let taskMod = imports.tasks[taskname];
	    for (let defname in taskMod) {
		if (defname.indexOf('Task') !== 0)
		    continue;
		let cls = taskMod[defname];
		let instance = new cls;
		this.register(instance);
	    }
	}
    },

    register: function(taskdef) {
	this._tasks.push(taskdef);
    },

    _pushRecurse: function(taskName, seen) {
	if (seen[taskName])
	    return null;
	let result = null;
	for (let i = 0; i < this._tasks.length; i++) {
	    let taskDef = this._tasks[i];
	    let pattern = taskDef.getPattern();
	    let re = pattern[0];
	    let match = re.exec(taskName);
	    if (!match)
		continue;

	    let serial = this._taskSerial;
	    this._taskSerial++;
	    let vars = {};
	    for (let i = 1; i < pattern.length; i++) {
		vars[pattern[i]] = match[i];
	    }
	    let specifiedDependencies = taskDef.getDepends(vars);;
	    let waitingDependencies = {};
	    for (let j = 0; j < specifiedDependencies.length; j++) {
		let depName = specifiedDependencies[j];
		if (!this._completeTasks[depName]) {
		    let depTask = this._pushRecurse(depName, seen);
		    waitingDependencies[depName] = depTask;
		}
	    }
	    result = {name: taskName,
		      def: taskDef,
		      vars: vars,
		      dependencies: specifiedDependencies,
		      waitingDependencies: waitingDependencies,
		      serial: serial,
		      result: null };
	    this._pendingTasksList.push(result);
	    seen[taskName] = true;
	    break;
	}
	if (!result)
	    throw new Error("No task definition matches " + taskName);
	this._queueRecalculate();
	return result;
    },

    push: function(taskName) {
	return this._pushRecurse(taskName, {});
    },

    _queueRecalculate: function() {
	if (this._idleRecalculateId > 0)
	    return;
	this._idleRecalculateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this, this._recalculate));
    },

    _visit: function(task, sorted, scanned) {
	if (scanned[task.name])
	    return;
	scanned[task.name] = true;
	for (let depName in task.waitingDependencies) {
	    let dep = task.waitingDependencies[depName];
	    this._visit(dep, sorted, scanned);
	}
	sorted.push(task);
    },

    _recalculate: function() {
	let sorted = [];
	let scanned = {};

	this._idleRecalculateId = 0;

	if (this._executing.length == 0 &&
	    this._pendingTasksList.length == 0) {
	    this._onEmpty();
	    return;
	} else if (this._pendingTasksList.length == 0) {
	    return;
	}

	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let task = this._pendingTasksList[i];
	    this._visit(task, sorted, scanned);
	}

	this._pendingTasksList = sorted;

	this._reschedule();
    },

    _onComplete: function(result, error, task) {
	if (error) {
	    print("TaskMaster: While executing " + task.name + ": " + error);
	    this._taskErrors[task.name] = error;
	} else {
	    print("TaskMaster: Completed: " + task.name + " : " + JSON.stringify(result));
	}
	let idx = -1;
	for (let i = 0; i < this._executing.length; i++) {
	    let executingTask = this._executing[i];
	    if (executingTask.serial != task.serial)
		continue;
	    idx = i;
	    break;
	}
	if (idx == -1)
	    throw new Error("TaskMaster: Internal error - Failed to find completed task serial:" + task.serial);
	task.result = result;
	this._completeTasks[task.name] = task;
	this._executing.splice(idx, 1);
	for (let i = 0; i < this._pendingTasksList.length; i++) {
	    let pendingTask = this._pendingTasksList[i];
	    let deps = pendingTask.waitingDependencies;
	    if (deps[task.name]) {
		print("Completed dep + " + task.name);
		delete deps[task.name];
	    }
	}
	this._queueRecalculate();
    },

    _hasDeps: function(task) {
	for (let depName in task.waitingDependencies) {
	    return true;
	}
	return false;
    },

    _reschedule: function() {
	while (this._executing.length < this.maxConcurrent &&
	       this._pendingTasksList.length > 0 &&
	       !this._hasDeps(this._pendingTasksList[0])) {
	    let task = this._pendingTasksList.shift();
	    print("TaskMaster: running: " + task.name);
	    let depResults = [];
	    for (let i = 0; i < task.dependencies.length; i++) {
		let depName = task.dependencies[i];
		depResults.push(this._completeTasks[depName].result);
	    }
	    task.def.execute(task.vars, depResults, this.cancellable, Lang.bind(this, this._onComplete, task));
	    this._executing.push(task);
	}
    }
});

const TaskDef = new Lang.Class({
    Name: 'TaskDef',

    _init: function() {
    },

    getPattern: function() {
	throw new Error("Not implemented");
    },

    getDepends: function(inputs) {
	return [];
    },

    execute: function(inputs, dependResults, cancellable, onComplete) {
	throw new Error("Not implemented");
    }
});

function demo(argv) {
    var loop = GLib.MainLoop.new(null, true);
    let ecode = 1;
    var app = new TaskMaster('taskmaster/', {onEmpty: function() {
	print("TaskMaster: idle");
	loop.quit();
    }});
    for (let i = 0; i < argv.length; i++) {
	let taskName = argv[i];
	app.push(taskName);
    };
    loop.run();
    ecode = 0; 
    return ecode;
}
