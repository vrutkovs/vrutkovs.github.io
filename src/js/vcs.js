// Copyright (C) 2011,2012 Colin Walters <walters@verbum.org>
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

const Params = imports.params;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GSystem = imports.gi.GSystem;

const ProcUtil = imports.procutil;
const BuildUtil = imports.buildutil;

function getMirrordir(mirrordir, keytype, uri, params) {
    params = Params.parse(params, {prefix: ''});
    let colon = uri.indexOf('://');
    let scheme, rest;
    if (colon >= 0) {
        scheme = uri.substr(0, colon);
        rest = uri.substr(colon+3);
    } else {
        scheme = 'file';
        if (GLib.path_is_absolute(uri))
            rest = uri.substr(1);
        else
            rest = uri;
    }
    let prefix = params.prefix ? params.prefix + '/' : '';
    let relpath = prefix + keytype + '/' + scheme + '/' + rest;
    return mirrordir.resolve_relative_path(relpath);
}

function _fixupSubmoduleReferences(mirrordir, cwd, cancellable) {
    let lines = ProcUtil.runSyncGetOutputLines(['git', 'submodule', 'status'],
					       cancellable, {cwd: cwd}); 
    let haveSubmodules = false;
    for (let i = 0; i < lines.length; i++) {
	let line = lines[i];
        if (line == '') continue;
        haveSubmodules = true;
        line = line.substr(1);
        let [subChecksum, subName, rest] = line.split(' ');
	let configKey = Format.vprintf('submodule.%s.url', [subName]);
        let subUrl = ProcUtil.runSyncGetOutputUTF8Stripped(['git', 'config', '-f', '.gitmodules', configKey],
							   cancellable, {cwd: cwd});
        let localMirror = getMirrordir(mirrordir, 'git', subUrl);
	ProcUtil.runSync(['git', 'config', configKey, 'file://' + localMirror.get_path()],
			 cancellable, {cwd:cwd});
    }
    return haveSubmodules;
}

function getVcsCheckout(mirrordir, keytype, uri, dest, branch, cancellable, params) {
    params = Params.parse(params, {overwrite: true,
				   quiet: false});
    let moduleMirror = getMirrordir(mirrordir, keytype, uri);
    let checkoutdirParent = dest.get_parent();
    GSystem.file_ensure_directory(checkoutdirParent, true, cancellable);
    let tmpDest = checkoutdirParent.get_child(dest.get_basename() + '.tmp');
    GSystem.shutil_rm_rf(tmpDest, cancellable);
    let ftype = dest.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
    if (ftype == Gio.FileType.SYMBOLIC_LINK) {
        GSystem.file_unlink(dest, cancellable);
    } else if (ftype == Gio.FileType.DIRECTORY) {
        if (params.overwrite) {
	    GSystem.shutil_rm_rf(dest, cancellable);
        } else {
            tmpDest = dest;
	}
    }
    ftype = tmpDest.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
    if (ftype != Gio.FileType.DIRECTORY) {
        ProcUtil.runSync(['git', 'clone', '-q', '--origin', 'localmirror',
			  '--no-checkout', moduleMirror.get_path(), tmpDest.get_path()], cancellable);
        ProcUtil.runSync(['git', 'remote', 'add', 'upstream', uri], cancellable, {cwd: tmpDest});
    } else {
        ProcUtil.runSync(['git', 'fetch', 'localmirror'], cancellable, {cwd: tmpDest});
    }
    ProcUtil.runSync(['git', 'checkout', '-q', branch], cancellable, {cwd: tmpDest});
    ProcUtil.runSync(['git', 'submodule', 'init'], cancellable, {cwd: tmpDest});
    let haveSubmodules = _fixupSubmoduleReferences(mirrordir, tmpDest, cancellable);
    if (haveSubmodules) {
        ProcUtil.runSync(['git', 'submodule', 'update'], cancellable, {cwd: tmpDest});
    }
    if (!tmpDest.equal(dest)) {
        GSystem.file_rename(tmpDest, dest, cancellable);
    }
    return dest;
}

function clean(keytype, checkoutdir, cancellable) {
    ProcUtil.runSync(['git', 'clean', '-d', '-f', '-x'], cancellable,
		     {cwd: checkoutdir});
}

function parseSrcKey(srckey) {
    let idx = srckey.indexOf(':');
    if (idx < 0) {
        throw new Error("Invalid SRC uri=" + srckey);
    }
    let keytype = srckey.substr(0, idx);
    if (!(keytype == 'git' || keytype == 'local')) {
        throw new Error("Unsupported SRC uri=" + srckey);
    }
    let uri = srckey.substr(idx+1);
    return [keytype, uri];
}
    
function checkoutPatches(mirrordir, patchdir, component, cancellable, params) {
    params = Params.parse(params, { patchesPath: null });
    let patches = component['patches'];
    let patches_keytype = null;
    let patches_uri = null;
    if (params.patchesPath != null) {
        patches_keytype = local;
	patches_uri = patches_path;
        patchdir = patches_uri;
    } else {
        [patches_keytype, patches_uri] = parseSrcKey(patches['src']);
        let patchesMirror = getMirrordir(mirrordir, patches_keytype, patches_uri);
        getVcsCheckout(mirrordir, patches_keytype, patches_uri,
                       patchdir, patches['revision'], cancellable,
                       {overwrite: true,
                        quiet: true});
    }

    return patchdir;
}

function getLastfetchPath(mirrordir, keytype, uri, branch) {
    let mirror = getMirrordir(mirrordir, keytype, uri);
    let branchSafename = branch.replace(/[\/.]/g, '_');
    return mirror.get_parent().get_child(mirror.get_basename() + '.lastfetch-' + branchSafename);
}

function _listSubmodules(mirrordir, mirror, keytype, uri, branch, cancellable) {
    let currentVcsVersion = ProcUtil.runSyncGetOutputUTF8(['git', 'rev-parse', branch], cancellable,
							  {cwd: mirror}).replace(/[ \n]/g, '');
    let tmpCheckout = getMirrordir(mirrordir, keytype, uri, {prefix:'_tmp-checkouts'});
    GSystem.shutil_rm_rf(tmpCheckout, cancellable);
    GSystem.file_ensure_directory(tmpCheckout.get_parent(), true, cancellable);
    ProcUtil.runSync(['git', 'clone', '-q', '--no-checkout', mirror.get_path(), tmpCheckout.get_path()], cancellable);
    ProcUtil.runSync(['git', 'checkout', '-q', '-f', currentVcsVersion], cancellable,
		     {cwd: tmpCheckout});
    let submodules = []
    let lines = ProcUtil.runSyncGetOutputLines(['git', 'submodule', 'status'],
					       cancellable, {cwd: tmpCheckout}); 
    for (let i = 0; i < lines.length; i++) {
	let line = lines[i];
        if (line == '') continue;
        line = line.substr(1);
        let [subChecksum, subName, rest] = line.split(' ');
        let subUrl = ProcUtil.runSyncGetOutputUTF8Stripped(['git', 'config', '-f', '.gitmodules',
							    Format.vprintf('submodule.%s.url', [subName])], cancellable,
							   {cwd: tmpCheckout});
        submodules.push([subChecksum, subName, subUrl]);
    }
    GSystem.shutil_rm_rf(tmpCheckout, cancellable);
    return submodules;
}

function ensureVcsMirror(mirrordir, keytype, uri, branch, cancellable,
			 params) {
    params = Params.parse(params, { fetch: false,
				    fetchKeepGoing: false,
				    timeoutSec: 0 });
    let fetch = params.fetch;
    let mirror = getMirrordir(mirrordir, keytype, uri);
    let tmpMirror = mirror.get_parent().get_child(mirror.get_basename() + '.tmp');
    let didUpdate = false;
    let lastFetchPath = getLastfetchPath(mirrordir, keytype, uri, branch);
    let lastFetchContents = null;
    let currentTime = GLib.DateTime.new_now_utc();
    let lastFetchContents = null;
    let lastFetchInfo = null;
    try {
	lastFetchInfo = lastFetchPath.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, cancellable);
    } catch (e) {
	if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
	    throw e;
    }
    if (lastFetchInfo != null) {
	lastFetchContents = GSystem.file_load_contents_utf8(lastFetchPath, cancellable).replace(/[ \n]/g, '');
	if (params.timeoutSec > 0) {
	    let lastFetchTime = GLib.DateTime.new_from_unix_local(lastFetchInfo.get_attribute_uint64('time::modified'));
	    let diff = currentTime.difference(lastFetchTime) / 1000 / 1000;
	    if (diff < params.timeoutSec) {
		fetch = false;
	    }
	}
    }
    GSystem.shutil_rm_rf(tmpMirror, cancellable);
    if (!mirror.query_exists(cancellable)) {
        ProcUtil.runSync(['git', 'clone', '--mirror', uri, tmpMirror.get_path()], cancellable);
        ProcUtil.runSync(['git', 'config', 'gc.auto', '0'], cancellable, {cwd: tmpMirror});
        GSystem.file_rename(tmpMirror, mirror, cancellable);
    } else if (fetch) {
	try {
            ProcUtil.runSync(['git', 'fetch'], cancellable, {cwd:mirror});
	} catch (e) {
	    if (!params.fetchKeepGoing)
		throw e;
	}
    }

    let currentVcsVersion = ProcUtil.runSyncGetOutputUTF8(['git', 'rev-parse', branch], cancellable,
							  {cwd: mirror}).replace(/[ \n]/g, '');

    let changed = currentVcsVersion != lastFetchContents; 
    if (changed) {
        print(Format.vprintf("last fetch %s differs from branch %s", [lastFetchContents, currentVcsVersion]));
	_listSubmodules(mirrordir, mirror, keytype, uri, branch, cancellable).forEach(function (elt) {
	    let [subChecksum, subName, subUrl] = elt;
	    print("Processing submodule " + subName + " at " + subChecksum + " from " + subUrl);
            ensureVcsMirror(mirrordir, keytype, subUrl, subChecksum, cancellable, params);
	});
    }
    
    if (changed || (fetch && params.timeoutSec > 0)) {
	lastFetchPath.replace_contents(currentVcsVersion, null, false, 0, cancellable); 
    }

    return mirror;
}

function uncacheRepository(mirrordir, keytype, uri, branch, cancellable) {
    let lastFetchPath = getLastfetchPath(mirrordir, keytype, uri, branch);
    GSystem.shutil_rm_rf(lastFetchPath, cancellable);
}

function fetch(mirrordir, keytype, uri, branch, cancellable, params) {
    params = Params.parse(params, {keepGoing: false, timeoutSec: 0});
    ensureVcsMirror(mirrordir, keytype, uri, branch, cancellable,
		      { fetch:true,
			fetchKeepGoing: params.keepGoing,
			timeoutSec: params.timeoutSec });
}

function describeVersion(dirpath, branch) {
    let args = ['git', 'describe', '--long', '--abbrev=42', '--always'];
    if (branch) {
        args.push(branch);
    }
    return ProcUtil.runSyncGetOutputUTF8(args, null, {cwd:dirpath}).replace(/[ \n]/g, '');
}
