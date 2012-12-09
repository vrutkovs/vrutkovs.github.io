const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const GSystem = imports.gi.GSystem;
const Params = imports.params;
const StreamUtil = imports.streamutil;

function objectToEnvironment(o) {
    let r = [];
    for (let k in o)
	r.push(k + "=" + o[k]);
    return r;
}

function _setContextFromParams(context, params) {
    params = Params.parse(params, {cwd: null,
				   env: null,
				   stderr: null });
    if (typeof(params.cwd) == 'string')
	context.set_cwd(params.cwd);
    else if (params.cwd)
	context.set_cwd(params.cwd.get_path());

    if (params.env)
	context.set_environment(params.env);

    if (params.stderr)
	context.set_stderr_disposition(params.stderr);
}

function _wait_sync_check_internal(proc, cancellable) {
    try {
	proc.wait_sync_check(cancellable);
    } catch (e) {
	if (e.domain == GLib.spawn_exit_error_quark() ||
	    e.matches(GLib.SpawnError, GLib.SpawnError.FAILED))
	    throw new Error(Format.vprintf("Child process %s: %s", [JSON.stringify(proc.context.argv), e.message]));
	else
	    throw e;
    }
}

function runSync(args, cancellable, params) {
    let context = new GSystem.SubprocessContext({argv: args});
    _setContextFromParams(context, params);
    let proc = new GSystem.Subprocess({context: context});
    proc.init(cancellable);
    _wait_sync_check_internal(proc, cancellable);
}

function _runSyncGetOutputInternal(args, cancellable, params, splitLines) {
    params = Params.parse(params, {cwd: null});
    let context = new GSystem.SubprocessContext({argv: args});
    _setContextFromParams(context, params);
    context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.PIPE);
    context.set_stderr_disposition(GSystem.SubprocessStreamDisposition.INHERIT);
    let proc = new GSystem.Subprocess({context: context});
    proc.init(cancellable);
    let input = proc.get_stdout_pipe();
    let dataIn = Gio.DataInputStream.new(input);

    let result;
    if (splitLines) {
	result = StreamUtil.dataInputStreamReadLines(dataIn, cancellable);
    } else {
	result = '';
	while (true) {
	    let [line, len] = dataIn.read_line_utf8(cancellable);
	    if (line == null)
		break;
	    result += line;
	}
    }
    _wait_sync_check_internal(proc, cancellable);
    return result;
}

function runSyncGetOutputLines(args, cancellable, params) {
    return _runSyncGetOutputInternal(args, cancellable, params, true);
}

function runSyncGetOutputUTF8(args, cancellable, params) {
    return _runSyncGetOutputInternal(args, cancellable, params, false);
}

function runSyncGetOutputUTF8Stripped(args, cancellable, params) {
    return _runSyncGetOutputInternal(args, cancellable, params, false).replace(/[ \n]+$/, '');
}

function runSyncGetOutputUTF8StrippedOrNull(args, cancellable, params) {
    try {
	params.stderr = Gio.SubprocessStreamDisposition.NULL;
	return runSyncGetOutputUTF8Stripped(args, cancellable, params);
    } catch (e) {
	if (e.domain == GLib.spawn_exit_error_quark())
	    return null;
	throw e;
    }
}

function asyncWaitCheckFinish(process, result) {
    let [waitSuccess, estatus] = process.wait_finish(result);
    let success = false;
    let errorMsg = null;
    try {
	GLib.spawn_check_exit_status(estatus);
	return [true, null];
    } catch (e) {
	if (e.domain == GLib.spawn_exit_error_quark() ||
	    e.matches(GLib.SpawnError, GLib.SpawnError.FAILED))
	    return [false, e.message];
	else
	    throw e;
    }
}
