###
# Copyright (c) 2003-2004, Jeremiah Fincher
# Copyright (c) 2012 Colin Walters <walters@verbum.org>
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
#   * Redistributions of source code must retain the above copyright notice,
#     this list of conditions, and the following disclaimer.
#   * Redistributions in binary form must reproduce the above copyright notice,
#     this list of conditions, and the following disclaimer in the
#     documentation and/or other materials provided with the distribution.
#   * Neither the name of the author of this software nor the name of
#     contributors to this software may be used to endorse or promote products
#     derived from this software without specific prior written consent.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
###

import time
import os
import shutil
import tempfile
import json

import supybot.ircdb as ircdb
import supybot.ircmsgs as ircmsgs
import supybot.ircutils as ircutils
import supybot.conf as conf
import supybot.utils as utils
from supybot.commands import *
import supybot.schedule as schedule
import supybot.callbacks as callbacks
import supybot.world as world

class GNOMEOSTree(callbacks.Plugin):
    def __init__(self, irc):
        self.__parent = super(GNOMEOSTree, self)
        self.__parent.__init__(irc)
        schedule.addPeriodicEvent(self._query_new_build, 1, now=False)
        self._irc = irc
        self._last_version = None

    def _broadcast(self, msg):
        for channel in self._irc.state.channels:
            self._irc.queueMsg(ircmsgs.privmsg(channel, msg))

    def _query_new_build(self, status=False):
        path = os.path.expanduser('~/ostbuild/work/autobuilder-default.json')
        f = open(path)
        data = json.load(f)
        f.close()
        
        builds = data['build']
        if len(builds) == 0:
            if status:
                self._broadcast("No builds")
            return
        latest = None
        for build in reversed(builds):
            if build['state'] == 'running':
                continue
            latest = build
            break
        version = latest['meta']['version']
        version_matches = version == self._last_version
        if (not status and version_matches):
            return

        self._last_version = version
        if (not status and not version_matches):
            msg = "New build"
        else:
            msg = "Current build"
            if status and builds[-1]['state'] == 'running':
                building = builds[-1]
                msg = "Active build: %s; %s" % (building['build-status']['description'], msg)
        msg += " %s: %s" % (version, latest['state'])
        diff = latest['diff']
        if len(diff[0]) > 0:
            msg += " Added modules: %s" % (', '.join(diff[0]), )
        if len(diff[1]) > 0:
            msg += " Updated modules: %s" % (', '.join(diff[1]), )
        if len(diff[2]) > 0:
            msg += " Removed modules: %s" % (', '.join(diff[2]), )

        msg += " http://ostree.gnome.org/work/tasks/%s-build/%s/log" % (data['prefix'],
                                                                        latest['v'])

        self._broadcast(msg)

    def buildstatus(self, irc, msg, args):
        self._query_new_build(status=True)

Class = GNOMEOSTree
