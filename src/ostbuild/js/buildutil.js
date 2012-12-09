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

function resolveComponent(manifest, componentMeta) {
    let result = {};
    Lang.copyProperties(componentMeta, result);
    let origSrc = componentMeta['src'];

    let didExpand = false;
    let vcsConfig = manifest['vcsconfig'];
    for (let vcsprefix in vcsConfig) {
	let expansion = vcsConfig[vcsprefix];
        let prefix = vcsprefix + ':';
        if (origSrc.indexOf(prefix) == 0) {
            result['src'] = expansion + origSrc.substr(prefix.length);
            didExpand = true;
            break;
	}
    }

    let name = componentMeta['name'];
    let src, idx, name;
    if (name == undefined) {
        if (didExpand) {
            src = origSrc;
            idx = src.lastIndexOf(':');
            name = src.substr(idx+1);
        } else {
            src = result['src'];
            idx = src.lastIndexOf('/');
            name = src.substr(idx+1);
	}
	let i = name.lastIndexOf('.git');
        if (i != -1 && i == name.length - 4) {
            name = name.substr(0, name.length - 4);
	}
        name = name.replace(/\//g, '-');
        result['name'] = name;
    }

    let branchOrTag = result['branch'] || result['tag'];
    if (!branchOrTag) {
        result['branch'] = 'master';
    }

    return result;
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
