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
    },

    register: function(taskdef) {
	this._tasks.push(taskdef);
    },
    
    push: function(taskName) {
	if (this._seenTasks[taskName])
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
		    let depTask = this.push(depName);
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
	    this._seenTasks[taskName] = true;
	    break;
	}
	if (!result)
	    throw new Error("No task definition matches " + taskName);
	this._queueRecalculate();
	return result;
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

const TaskChecksumSha256 = new Lang.Class({
    Name: 'TaskChecksumSha256',
    Extends: TaskDef,

    _init: function() {
    },

    getPattern: function() {
	return [/\/ChecksumSha256\/(.*)$/, 'PATH'];
    },

    _onAsyncOpComplete: function(error) {
	let state = this;
	state.asyncOutstanding--;
	if (state.asyncOutstanding != 0)
	    return;
	if (error) {
	    state.onComplete(null, error);
	} else {
	    let csumStr = state.buf.steal_as_bytes().toArray().toString();
	    state.onComplete(csumStr.substr(0, csumStr.indexOf(' ')), null);
	}
    },

    _onSpliceComplete: function(stream, result) {
	let state = this;

	let error = null;
	try {
	    stream.splice_finish(result);
	} catch (e) {
	    if (e.domain != undefined)
		error = e;
	    else
		throw e;
	}
	Lang.bind(state, state.me._onAsyncOpComplete)(error);
    },

    _onProcWait: function(proc, result) {
	let state = this;

	let error = null;
	try {
	    let [success,ecode] = proc.wait_finish(result);
	    GLib.spawn_check_exit_status(ecode);
	} catch (e) {
	    if (e.domain != undefined)
		error = e;
	    else
		throw e;
	}
	Lang.bind(state, state.me._onAsyncOpComplete)(error);
    },

    execute: function(inputs, dependResults, cancellable, onComplete) {
	let state = {me: this,
		     onComplete: onComplete,
		     buf: null,
		     asyncOutstanding: 2};
	let path = inputs.PATH;
	let context = new GSystem.SubprocessContext({argv: ['sha256sum', path]});
	context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.PIPE);
	let proc = new GSystem.Subprocess({context: context});
	proc.init(cancellable);
	let stdout = proc.get_stdout_pipe();
	state.buf = Gio.MemoryOutputStream.new_resizable();
	state.buf.splice_async(stdout, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
			       Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT,
			       cancellable, Lang.bind(state, this._onSpliceComplete));
	proc.wait(cancellable, Lang.bind(state, this._onProcWait));
    }
});

const TaskChecksumMany = new Lang.Class({
    Name: 'TaskChecksumMany',
    Extends: TaskDef,

    _init: function() {
    },

    getPattern: function() {
	return [/\/ChecksumMany\/(.*)$/, 'FILENAMES'];
    },

    getDepends: function(inputs) {
	let filenamesStr = inputs.FILENAMES;
	let filenames = filenamesStr.split(',');
	let r = [];
	for (let i = 0; i < filenames.length; i++)
	    r.push('/ChecksumSha256/' + filenames[i]);
	return r;
    },

    execute: function(inputs, dependResults, cancellable, onComplete) {
	let r = '';
	for (let i = 0; i < dependResults.length; i++)
	    r += dependResults[i] + '\n';
	GLib.idle_add(GLib.PRIORITY_DEFAULT, function() {
	    onComplete(r, null);
	});
    }
});

function demo(argv) {
    var loop = GLib.MainLoop.new(null, true);
    let ecode = 1;
    var app = new TaskMaster('taskmaster/', {onEmpty: function() {
	print("TaskMaster: Complete!");
	loop.quit();
    }});
    app.register(new TaskChecksumSha256());
    app.register(new TaskChecksumMany());
    for (let i = 0; i < argv.length; i++) {
	let taskName = argv[i];
	app.push(taskName);
    };
    loop.run();
    ecode = 0; 
    return ecode;
}
