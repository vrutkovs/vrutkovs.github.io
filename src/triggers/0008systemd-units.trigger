#!/bin/bash
# Post-installation hook for systemd unit files; -*- mode: sh -*-
#
# Written by Colin Walters <walters@verbum.org>
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the
# Free Software Foundation, Inc., 59 Temple Place - Suite 330,
# Boston, MA 02111-1307, USA.

set -e

if test -x "$(which systemctl 2>/dev/null)"; then
    # FIXME - need to make user presets work too
    for unittype in system; do 
	path=/usr/lib/systemd/${unittype}
	if test -d ${path}; then
	    for unitname in ${path}/*.service; do
		if test '!' -L ${unitname} &&
		    ! echo ${unitname} | grep -q '@\.service$' &&
		    grep -q '^\[Install\]' ${unitname}; then
		    bn=$(basename ${unitname})
		    echo systemctl --${unittype} preset ${bn}
		    systemctl --${unittype} preset ${bn}
		fi
	    done
	fi
    done
fi
