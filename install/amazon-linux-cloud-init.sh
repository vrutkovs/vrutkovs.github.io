#!/bin/sh
# Set up gnome-ostree build system on an Amazon Linux instance
#
# Copyright (C) 2012 Colin Walters <walters@verbum.org>
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

# Note: I'm not entirely sure why, but when allocating a larger
# instance store, the filesystem is still the default 8G.  Resizing
# here works.
resize2fs /dev/xvda1

cat > /etc/yum.repos.d/cdn-verbum-org.repo <<EOF
[cdn-verbum-org]
name=cdn.verbum.org/rpms
baseurl=http://cdn.verbum.org/rpms
gpgcheck=0
EOF

PACKAGES="
linux-user-chroot
git
make
gcc
gettext
libffi-devel
libattr-devel
libxml2-devel

autoconf automake binutils bison byacc cvs docbook-dtds docbook-style-dsssl
docbook-style-xsl docbook-utils doxygen elfutils flex gcc gcc-c++ gettext git 
gzip hg intltool libtool make patch pkgconfig sed subversion tar unzip

diffstat texinfo texi2html chrpath

httpd
"

yum -y install $PACKAGES

yum --enablerepo=epel -y install python-argparse

cat > /etc/httpd/conf.d/ostree.conf <<EOF
<VirtualHost *:80>
        DocumentRoot /home/ostree/public_html/

        ErrorLog /var/log/httpd/ostree-error_log
        ScriptLog /var/log/httpd/ostree-error_log
        CustomLog /var/log/httpd/ostree-access_log combined

        KeepAlive On
</VirtualHost>

<Directory "/home/ostree/public_html/">
     AllowOverride None
     Options Indexes MultiViews FollowSymLinks
     order allow,deny
     allow from all
</Directory>
EOF

service httpd start

adduser ostree
chmod a+x /home/ostree  # for httpd access

su - ostree -c 'set -e ; mkdir -p ~/src; cd ~/src;
test -d gnome-ostree || git clone --depth=1 git://git.gnome.org/gnome-ostree;
./gnome-ostree/install/ostree-user-install.sh' < /dev/null
