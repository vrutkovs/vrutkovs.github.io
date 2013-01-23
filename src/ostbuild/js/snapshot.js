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
const Lang = imports.lang;

const JsonDB = imports.jsondb;
const JsonUtil = imports.jsonutil;
const Params = imports.params;

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

const Snapshot = new Lang.Class({
    Name: 'Snapshot',
    
    _init: function(data, path) {
	this.data = data;
	this.path = path;
	this._componentDict = _componentDict(data);
	this._componentNames = [];
	for (let k in this._componentDict)
	    this._componentNames.push(k);
    },

    _expandComponent: function(component) {
	let r = {};
	Lang.copyProperties(component, r);
	let patchMeta = this.data['patches'];
	if (patchMeta) {
	    let componentPatchFiles = component['patches'] || [];
	    if (componentPatchFiles.length > 0) {
		let patches = {};
		Lang.copyProperties(patchMeta, patches);
		patches['files'] = componentPatchFiles;
		r['patches'] = patches;
	    }
	}
	let configOpts = (this.data['config-opts'] || []).concat();
	configOpts.push.apply(configOpts, component['config-opts'] || []);
	r['config-opts'] = configOpts;
	return r;
    },

    getAllComponentNames: function() {
	return this._componentNames;
    },

    getComponent: function(name, allowNone) {
	let r = this._componentDict[name] || null;
	if (!r && !allowNone)
	    throw new Error("No component " + name + " in snapshot");
	return r;
    },

    getExpanded: function(name) {
	return this._expandComponent(this.getComponent(name));
    }
});
