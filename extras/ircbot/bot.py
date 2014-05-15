###
# Copyright (c) 2003-2004, Jeremiah Fincher
# Copyright (c) 2012 Colin Walters <walters@verbum.org>
# Copyright (c) 2013 Jasper St. Pierre <jstpierre@mecheye.net>
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

HOST = "irc.gnome.org"
PORT = 6667

import itertools
import os
import json

from twisted.internet import protocol, task
from twisted.words.protocols import irc
from twisted.application import internet, service
from twisted.python import log

def mirc_color(code, S):
    return "\x03%d%s\x03" % (code, S)

GREEN = 3
RED = 4

class BuildGnomeOrg(irc.IRCClient):
    nickname = 'buildgnomeorg'
    username = nickname
    realname = nickname

    def __init__(self):
        self._flood_channels = ['#testable']
        self._status_channels = ['#gnome-hackers']
        self._joined_channels = []
        self._last_task_state = {}
        tracked_build = 'buildmaster'
        self._flood_tasks = ['build']
        self._announce_changed_tasks = ['resolve', 'smoketest', 'smoketest-classic', 'smoketest-wayland', 'integrationtest', 'applicationstest']
        self._workdir = os.path.expanduser('/srv/ostree/ostbuild/%s/' % (tracked_build, ))
        self._workurl = "http://build.gnome.org/continuous/%s" % (tracked_build, )
        self._loop = task.LoopingCall(self._query_new_tasks)

    def signedOn(self):
        for chan in self._flood_channels:
            self.join(chan)
        for chan in self._status_channels:
            self.join(chan)

        self._loop.start(1)

    def joined(self, channel):
        if channel not in self._joined_channels:
            self._joined_channels.append(channel)

    def _msg_unicode(self, channel, msg):
        self.msg(channel, msg.encode('utf8'))

    def _sendTo(self, channels, msg):
        for channel in channels:
            self._msg_unicode(channel, msg)

    def _query_new_tasks(self):
        for taskname in self._flood_tasks:
            self._query_new_task(taskname, announce_always=True)
        for taskname in self._announce_changed_tasks:
            self._query_new_task(taskname, announce_always=False)

    def _get_task_state(self, taskname):
        current_task_path = os.path.join(self._workdir, 'results/tasks/%s/%s/' % (taskname, taskname))
        meta_path = os.path.join(current_task_path, 'meta.json')
        try:
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
        except Exception as e:
            print("Error occurred in _get_task_state(%s): %s" % (taskname, e.message))
            return None, ""

    def _update_task_state(self, taskname):
        metadata, status_msg = self._get_task_state(taskname)
        if metadata is None:
            return None

        if not metadata['complete']:
            return None

        build_name = metadata['buildPath']

        last_state = self._last_task_state.get(taskname)
        last_build_name = last_state['buildPath'] if last_state else None
        build_unchanged = (build_name == last_build_name)

        self._last_task_state[taskname] = metadata

        if build_unchanged:
            return None
        else:
            return last_state, metadata, status_msg

    def _relpath_to_version(self, relpath):
        parts = relpath.split('/')
        return parts[1] + parts[2] + parts[3] + '.' + parts[4];

    def _status_line_for_task(self, taskname):
        metadata, status_msg = self._get_task_state(taskname)
        build_name = self._relpath_to_version(metadata['buildPath'])
        millis = float(metadata['elapsedMillis'])
        success = metadata['success']
        success_str = success and 'successful' or 'failed'

        msg = u"continuous:%s %s: %s in %.1f seconds. %s " \
              % (taskname, build_name, success_str, millis / 1000.0, status_msg)

        msg += "%s/%s/" % (self._workurl, metadata['path'])

        if not success:
            msg = mirc_color(RED, msg)
        else:
            msg = mirc_color(GREEN, msg)

        return msg

    def _get_channels_for_changed_components(self, taskname):
        current_task_path = os.path.join(self._workdir, 'results/tasks/%s/%s/' % (taskname, taskname))
        build_path = os.path.join(current_task_path, 'build.json')
        if not os.path.exists(build_path):
            return []

        f = open(build_path)
        build = json.load(f)
        f.close()

        if 'built' not in build.keys():
            return []

        component_names = [x['name'] for x in build['built'] if 'name' in x.keys()]

        snapshot_path = os.path.join(current_task_path, 'snapshot.json')
        if not os.path.exists(snapshot_path):
            return []

        f = open(snapshot_path)
        snapshot = json.load(f)
        f.close()

        if 'components' not in snapshot.keys():
            return []

        component_descriptions = [x for x in snapshot['components'] if 'name' in x.keys() and x['name'] in component_names]

        return [x['irc_room'].encode("utf-8") for x in component_descriptions if 'irc_room' in x.keys()]

    def _query_new_task(self, taskname, announce_always=False):
        querystate = self._update_task_state(taskname)
        if querystate is None:
            return

        (last_state, new_state, status_msg) = querystate
        print "New version of %s: %r" % (taskname, querystate)
        if last_state is not None:
            last_success = last_state['success']
        else:
            last_success = True
        success = new_state['success']
        success_changed = last_success != success

        msg = self._status_line_for_task(taskname)

        affected_channels = self._get_channels_for_changed_components(taskname)

        if announce_always or success_changed:
            self._sendTo(self._flood_channels, msg)
        if success_changed:
            self._sendTo(self._status_channels, msg)
            if affected_channels:
                for channel in affected_channels:
                    if channel not in self._joined_channels:
                        self.join(channel)
                    self._sendTo(channel, msg)

    def _buildstatus_for_task(self, taskname):
        metadata, status_msg = self._get_task_state(taskname)
        if metadata is None:
            return "No current %s completed" % (taskname, )
        else:
            return self._status_line_for_task(taskname)

    def privmsg(self, user, channel, message):
        message = message.strip()
        if message == '@buildstatus':
            for taskname in itertools.chain(self._flood_tasks, self._announce_changed_tasks):
                status = self._buildstatus_for_task(taskname)
                self._msg_unicode(channel, status)

class BuildGnomeOrgFactory(protocol.ReconnectingClientFactory):
    protocol = BuildGnomeOrg

application = service.Application('continuous')
ircService = internet.TCPClient(HOST, PORT, BuildGnomeOrgFactory())
ircService.setServiceParent(application)
