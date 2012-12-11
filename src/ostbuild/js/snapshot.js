//
// Copyright (C) 2012 Colin Walters <walters@verbum.org>
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

const Gio = imports.gi.Gio;

const JsonDB = imports.jsondb;
const Lang = imports.lang;

function _componentDict(snapshot) {
    let r = {};
    let components = snapshot['components'];
    for (let i = 0; i< components.length; i++) {
	let component = components[i];
	let name = component['name'];
        r[name] = component;
    }
    let patches = snapshot['patches'];
    r[patches['name']] = patches;
    let base = snapshot['base'];
    r[base['name']] = base;
    return r;
}

function snapshotDiff(a, b) {
    let a_components = _componentDict(a);
    let b_components = _componentDict(b);

    let added = [];
    let modified = [];
    let removed = [];

    for (let name in a_components) {
        let c_a = a_components[name];
        let c_b = b_components[name];
        if (c_b == undefined) {
            removed.push(name);
	} else if (c_a['revision'] != c_b['revision']) {
            modified.push(name);
	}
    }
    for (let name in b_components) {
        if (a_components[name] == undefined) {
            added.push(name);
	}
    }
    return [added, modified, removed];
}

function load(db, prefix, pathName, cancellable) {
    if (pathName) {
	let path = Gio.File.new_for_path(pathName);
	return [db.loadFromPath(Gio.File.new_for_path(pathName), cancellable), path];
    } else if (prefix) {
	let path = db.getLatestPath();
	return [db.loadFromPath(path, cancellable), path];
    } else {
	throw new Error("No prefix or snapshot specified");
    }
}

function getComponent(snapshot, name, allowNone) {
    let d = _componentDict(snapshot);
    let r = d[name] || null;
    if (!r && !allowNone)
	throw new Error("No component " + name + " in snapshot");
    return r;
}

function expandComponent(snapshot, component) {
    let r = {};
    Lang.copyProperties(component, r);
    let patchMeta = snapshot['patches'];
    if (patchMeta) {
	let componentPatchFiles = component['patches'] || [];
	if (componentPatchFiles.length > 0) {
	    let patches = {};
	    Lang.copyProperties(patchMeta, patches);
	    patches['files'] = componentPatchFiles;
	    r['patches'] = patches;
	}
    }
    let configOpts = (snapshot['config-opts'] || []).concat();
    configOpts.push.apply(configOpts, component['config-opts'] || []);
    r['config-opts'] = configOpts;
    return r;
}

function getExpanded(snapshot, name) {
    return expandComponent(snapshot, getComponent(snapshot, name));
}


