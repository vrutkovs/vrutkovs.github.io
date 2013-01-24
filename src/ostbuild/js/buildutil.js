// Copyright (C) 2011 Colin Walters <walters@verbum.org>
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

const GSystem = imports.gi.GSystem;

const BUILD_ENV = {
    'HOME' : '/', 
    'HOSTNAME' : 'ostbuild',
    'LANG': 'C',
    'PATH' : '/usr/bin:/bin:/usr/sbin:/sbin',
    'SHELL' : '/bin/bash',
    'TERM' : 'vt100',
    'TMPDIR' : '/tmp',
    'TZ': 'EST5EDT'
    };

function parseSrcKey(srckey) {
    let idx = srckey.indexOf(':');
    if (idx < 0) {
        throw new Error("Invalid SRC uri=" + srckey);
    }
    let keytype = srckey.substr(0, idx);
    if (!(keytype == 'git' || keytype == 'local')) 
        throw new Error("Unsupported SRC uri=" + srckey);
    let uri = srckey.substr(idx+1);
    return [keytype, uri];
}



function getPatchPathsForComponent(patchdir, component) {
    let patches = component['patches'];
    if (!patches)
	return [];
    let patchSubdir = patches['subdir'];
    let subPatchdir;
    if (patchSubdir) {
        subPatchdir = patchdir.get_child(patchSubdir);
    } else {
        subPatchdir = patchdir;
    }
    let result = [];
    let files = patches['files'];
    for (let i = 0; i < files.length; i++) {
        result.push(subPatchdir.get_child(files[i]));
    }
    return result;
}

function findUserChrootPath() {
    // We need to search PATH here manually so we correctly pick up an
    // ostree install in e.g. ~/bin even though we're going to set PATH
    // below for our children inside the chroot.
    let userChrootPath = null;
    let elts = GLib.getenv('PATH').split(':');
    for (let i = 0; i < elts.length; i++) {
	let dir = Gio.File.new_for_path(elts[i]);
	let child = dir.get_child('linux-user-chroot');
        if (child.query_exists(null)) {
            userChrootPath = child;
            break;
	}
    }
    return userChrootPath;
}

function getBaseUserChrootArgs() {
    let path = findUserChrootPath();
    return [path.get_path(), '--unshare-pid', '--unshare-ipc', '--unshare-net'];
}

function compareVersions(a, b) {
    let adot = a.indexOf('.');
    while (adot != -1) {
	let bdot = b.indexOf('.');
	if (bdot == -1)
	    return 1;
	let aSub = parseInt(a.substr(0, adot));
	let bSub = parseInt(b.substr(0, bdot));
	if (aSub > bSub)
	    return 1;
	else if (aSub < bSub)
	    return -1;
	a = a.substr(adot + 1);
	b = b.substr(bdot + 1);
	adot = a.indexOf('.');
    }
    if (b.indexOf('.') != -1)
	return -1;
    let aSub = parseInt(a);
    let bSub = parseInt(b);
    if (aSub > bSub)
	return 1;
    else if (aSub < bSub)
	return -1;
    return 0;
}

function atomicSymlinkSwap(linkPath, newTarget, cancellable) {
    let parent = linkPath.get_parent();
    let tmpLinkPath = parent.get_child('current-new.tmp');
    GSystem.shutil_rm_rf(tmpLinkPath, cancellable);
    let relpath = parent.get_relative_path(newTarget);
    tmpLinkPath.make_symbolic_link(relpath, cancellable);
    GSystem.file_rename(tmpLinkPath, linkPath, cancellable);
}
