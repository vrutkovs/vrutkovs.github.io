const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const GSystem = imports.gi.GSystem;

function runSync(args, stdoutDisposition, stderrDisposition) {
    if (stdoutDisposition == undefined)
	stdoutDisposition = GSystem.SubprocessStreamDisposition.INHERIT;
    if (stderrDisposition == undefined)
	stderrDisposition = GSystem.SubprocessStreamDisposition.INHERIT;
    var proc = GSystem.Subprocess.new_simple_argv(args, stdoutDisposition, stderrDisposition);
    proc.wait_sync_check(null);
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
