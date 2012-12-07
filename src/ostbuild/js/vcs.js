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
const GSystem = imports.gi.GSystem;

const ProcUtil = imports.procutil;

function getMirrordir(mirrordir, keytype, uri, params) {
    params = Params.parse(params, {prefix: ''});
    let colon = uri.indexOf('://');
    let scheme = uri.substr(0, colon);
    let rest = uri.substr(colon+3);
    let slash = rest.indexOf('/');
    let netloc = rest.substr(0, slash);
    let path = rest.substr(slash+1);
    let prefix = params.prefix ? params.prefix + '/' : '';
    return mirrordir.resolve_relative_path(prefix + keytype + '/' + 
					   scheme + '/' + netloc + '/' +
					   path);
}

function _fixupSubmoduleReferences(mirrordir, cwd, cancellable) {
    let lines = ProcUtil.runSyncGetOutputLines(['git', 'submodule', 'status'],
					       cancellable, {cwd: cwd.get_path()}); 
    let haveSubmodules = false;
    for (let i = 0; i < lines.length; i++) {
	let line = lines[i];
        if (line == '') continue;
        haveSubmodules = true;
        line = line.substr(1);
        let [subChecksum, subName, rest] = line.split(' ');
	let configKey = Format.vprintf('submodule.%s.url', [subName]);
        let subUrl = ProcUtil.runSyncGetOutputUTF8(['git', 'config', '-f', '.gitmodules', configKey],
						   cancellable, {cwd: cwd.get_path()});
        let localMirror = getMirrordir(mirrordir, 'git', subUrl);
	ProcUtil.runSync(['git', 'config', configKey, 'file://' + localMirror.get_path()],
			 cancellable, {cwd:cwd.get_path()});
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
	    GSystem.shutil_rm_rf(dest);
        } else {
            tmpDest = dest;
	}
    }
    ftype = tmpDest.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
    if (ftype != Gio.FileType.DIRECTORY) {
        ProcUtil.runSync(['git', 'clone', '-q', '--origin', 'localmirror',
			  '--no-checkout', moduleMirror.get_path(), tmpDest.get_path()], cancellable);
        ProcUtil.runSync(['git', 'remote', 'add', 'upstream', uri], cancellable, {cwd: tmpDest.get_path()});
    } else {
        ProcUtil.runSync(['git', 'fetch', 'localmirror'], cancellable, {cwd: tmpDest.get_path()});
    }
    ProcUtil.runSync(['git', 'checkout', '-q', branch], cancellable, {cwd: tmpDest.get_path()});
    ProcUtil.runSync(['git', 'submodule', 'init'], cancellable, {cwd: tmpDest.get_path()});
    let haveSubmodules = _fixupSubmoduleReferences(mirrordir, tmpDest, cancellable);
    if (haveSubmodules) {
        ProcUtil.runSync(['git', 'submodule', 'update'], cancellable, {cwd: tmpDest.get_path()});
    }
    if (!tmpDest.equal(dest)) {
        GSystem.file_rename(tmpDest, dest, cancellable);
    }
    return dest;
}

function clean(keytype, checkoutdir, cancellable) {
    ProcUtil.runSync(['git', 'clean', '-d', '-f', '-x'], cancellable,
		     {cwd: checkoutdir.get_path()});
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
    params = Params.parse(params, { patches_path: null });
    let patches = component['patches'];
    let patches_keytype = null;
    let patches_uri = null;
    if (params.patches_path != null) {
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

    
