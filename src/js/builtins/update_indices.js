// -*- indent-tabs-mode: nil; tab-width: 2; -*-
// Copyright (C) 2013 Colin Walters <walters@verbum.org>
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

const Lang = imports.lang;

const Builtin = imports.builtin;
const VersionedDir = imports.versioneddir;

const UpdateIndices = new Lang.Class({
    Name: 'UpdateIndices',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Update all JSON indices",

    _init: function() {
        this.parent();
    },

    execute: function(args, loop, cancellable) {
	      this._initWorkdir(null, cancellable);

        let buildsDir = new VersionedDir.VersionedDir(this.workdir.get_child('builds'));
        buildsDir.updateAllIndices(cancellable);

        return true;
    }
});
