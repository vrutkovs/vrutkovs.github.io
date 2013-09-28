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

import itertools
import os
import json

import supybot.ircmsgs as ircmsgs
import supybot.ircutils as ircutils
import supybot.schedule as schedule
import supybot.callbacks as callbacks

class GNOMEOSTree(callbacks.Plugin):
    def __init__(self, irc):
        super(GNOMEOSTree, self).__init__(irc)
        schedule.addPeriodicEvent(self._query_new_tasks, 1, now=False)
        self._irc = irc
        self._flood_channels = ['#testable']
        self._status_channels = ['#gnome-hackers']
        self._last_task_state = {}
        tracked_build = 'buildmaster'
        self._periodic_announce_seconds = 3*60*60
        self._periodic_announce_ticks = 0
        self._always_announce_tasks = ['build']
        self._announce_failed_tasks = ['resolve']
        self._announce_periodic_tasks = ['smoketest', 'integrationtest']
        self._workdir = os.path.expanduser('/srv/ostree/ostbuild/%s/' % (tracked_build, ))
        self._workurl = "http://build.gnome.org/continuous/%s" % (tracked_build, )

    def _sendTo(self, channels, msg):
        for channel in channels:
            self._irc.queueMsg(ircmsgs.privmsg(channel, msg))

    def _query_new_tasks(self):
        self._periodic_announce_ticks += 1
        for taskname in self._always_announce_tasks:
            self._query_new_task(taskname, announce_success=True)
        for taskname in self._announce_failed_tasks:
            self._query_new_task(taskname)
        for taskname in self._announce_periodic_tasks:
            self._query_new_task(taskname, announce_periodic=True)

    def _get_task_state(self, taskname):
        current_task_path = os.path.join(self._workdir, 'tasks/%s/current' % (taskname, ))
        meta_path = os.path.join(current_task_path, 'meta.json')
        if not os.path.exists(meta_path):
            return None, ""

        f = open(meta_path)
        metadata = json.load(f)
        f.close()

        status_path = os.path.join(current_task_path, 'status.txt')
        if os.path.exists(status_path):
            f = open(status_path)
            status_msg = f.read().strip()
            f.close()
        else:
            status_msg = ''

        return metadata, status_msg

    def _update_task_state(self, taskname):
        metadata, status_msg = self._get_task_state(taskname)
        if metadata is None:
            return None

        self._last_task_state[taskname] = metadata

        taskver = metadata['taskVersion']

        last_state = self._last_task_state.get(taskname)
        last_version = last_state['taskVersion'] if last_state else None
        version_unchanged = taskver == last_version
        if version_unchanged:
            return None
        else:
            return last_state, metadata, status_msg

    def _status_line_for_task(self, taskname):
        metadata, status_msg = self._get_task_state(taskname)
        taskver = metadata['taskVersion']
        millis = float(metadata['elapsedMillis'])
        success = metadata['success']
        success_str = success and 'successful' or 'failed'

        msg = "continuous:%s %s: %s in %.1f seconds. %s " \
              % (taskname, taskver, success_str, millis / 1000.0, status_msg)

        msg += "%s/%s/output.txt" % (self._workurl, metadata['path'])

        if not success:
            msg = ircutils.mircColor(msg, fg='red')
        else:
            msg = ircutils.mircColor(msg, fg='green')

        return msg

    def _query_new_task(self, taskname, announce_success=False, announce_periodic=False):
        querystate = self._update_task_state(taskname)
        if querystate is None:
            return
        (last_state, new_state, status_msg) = querystate
        last_success = last_state['success']
        success = new_state['success']
        success_changed = last_success != success

        msg = self._status_line_for_task(taskname)

        if announce_success:
            self._sendTo(self._flood_channels, msg)
        if ((not announce_periodic and success_changed) or
            (announce_periodic and self._periodic_announce_ticks == self._periodic_announce_seconds)):
            self._sendTo(self._status_channels, msg)

    def _buildstatus_for_task(self, taskname):
        metadata, status_msg = self._get_task_state(taskname)
        if metadata is None:
            return "No current %s completed" % (taskname, )
        else:
            return self._status_line_for_task(taskname)

    def buildstatus(self, irc, msg, args):
        for taskname in itertools.chain(self._always_announce_tasks, self._announce_failed_tasks, self._announce_periodic_tasks):
            irc.reply(self._buildstatus_for_task(taskname))

Class = GNOMEOSTree
