const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const GSystem = imports.gi.GSystem;
const Params = imports.params;

function _setContextFromParams(context, params) {
    params = Params.parse(params, {cwd: null});
    if (typeof(params.cwd) == 'string')
	context.set_cwd(params.cwd);
    else if (params.cwd)
	context.set_cwd(params.cwd.get_path());
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
    let resultLines = [];
    let resultBuf = '';
    while (true) {
	let [line, len] = dataIn.read_line_utf8(cancellable);
	if (line == null)
	    break;
	if (splitLines)
	    resultLines.push(line);
	else
	    resultBuf += line;
    }
    _wait_sync_check_internal(proc, cancellable);
    return splitLines ? resultLines : resultBuf;
}

function runSyncGetOutputLines(args, cancellable, params) {
    return _runSyncGetOutputInternal(args, cancellable, params, true);
}

function runSyncGetOutputUTF8(args, cancellable, params) {
    return _runSyncGetOutputInternal(args, cancellable, params, false);
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
