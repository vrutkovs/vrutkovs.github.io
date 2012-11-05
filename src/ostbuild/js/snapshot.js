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

function _componentDict(snapshot) {
    let r = {};
    for (let component in snapshot['components']) {
        r[component['name']] = component;
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
        let c_a = a_components[name]
        let c_b = b_components[name]
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
