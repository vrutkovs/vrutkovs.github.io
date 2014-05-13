(function(exports) {
    'use strict';

    var bgoControllers = angular.module('bgoControllers', []);

    var taskNames = ['resolve', 'bdiff', 'build', 'builddisks', 'smoketest', 'smoketest-classic', 'smoketest-wayland', 'integrationtest','applicationstest', ];

    var ROOT = '/continuous/buildmaster/';

    var YMD_SERIAL_VERSION_RE = /^(\d+)(\d\d)(\d\d)\.(\d+)$/;

    function formatDigits(x) {
        if (x < 10)
        return "0" + x;
        return "" + x;
    }

    function relpathToVersion(relpath) {
        var parts = relpath.split('/');
        parts.shift(); // Remove builds/
        return parts[0] + parts[1] + parts[2] + '.' + parts[3];
    };

    function versionToRelpath(version) {
        var match = YMD_SERIAL_VERSION_RE.exec(version);
        return match[1] + '/' + match[2] + '/' +
        match[3] + '/' + match[4];
    };

    bgoControllers.controller('ContinuousStatusCtrl', function($scope, $http) {
        $http.get(ROOT + 'results/tasks/build/build/meta.json').success(function(data) {
            $scope.status = data.success ? 'good' : 'bad';
            $scope.buildVersion = relpathToVersion(data.buildPath);
        });
    });

    function renderApps($http, path, callback) {
        $http.get(path + '/apps.json').success(function(data) {
            var apps = data['apps'];

            // Older builds use a different scheme for the
            // applicationstest; just ignore them.
            if (!apps.forEach)
                return;

            apps.forEach(function(app) {
                // Mangle the data a bit

                app.name = app.id; /* XXX */
                app.status = (app.state == "success") ? 'good' : 'bad';

                // XXX -- this should probably be in the template
                if (app.icon)
                    app.icon = ROOT + app.icon;
                else
                    app.icon = '/images/app-generic.png';

                app.screenshot = ROOT + app.screenshot;
            });
            callback(apps);
        });
    }

    bgoControllers.controller('ContinuousBuildViewCtrl', function($scope, $http, $routeParams) {
        var srcmap = {
            'git:git://git.kernel.org/pub/scm/': ['https://git.kernel.org/cgit/', '/commit/?id='],
            'git:git://anongit.freedesktop.org/': ['http://cgit.freedesktop.org/', '/commit/?id='],
            // FIXME: un ugly hack, we'd better uniform all sources in manifest,json
            'git:git://anongit.freedesktop.org/git/': ['http://cgit.freedesktop.org/', '/commit/?id='],
            'git:git://git.gnome.org/': ['https://git.gnome.org/browse/', '/commit/?id='],
            'git:git://github.com': ['https://github.com/', '/commit/']
        };


        var buildVersion = $routeParams.buildVersion;
        if (buildVersion === undefined) {
            return
        } 
        $scope.buildVersion = buildVersion;

        var buildPath = versionToRelpath(buildVersion);
        var buildRoot = ROOT + 'builds/' + buildPath + '/';
        $scope.buildRoot = buildRoot;

        var stages = [];
        var tasks = [];
        taskNames.forEach(function(taskName) {

            $http.get(buildRoot + taskName + '/meta.json').success(function(data) {
                // Mangle the data a bit so we can render it better
                data['name'] = taskName;
                data['started'] = true;
                data['version'] = relpathToVersion(data['buildPath']);
                data['elapsed'] = Math.round(data['elapsedMillis'] / 1000);
                if (taskName == 'bdiff') {
                    $http.get(buildRoot + '/bdiff.json').success(function(bdiffdata) {
                        data['bdiff'] = bdiffdata
                        for (var change in bdiffdata) {
                            for (var component in bdiffdata[change]){
                                var commitUrlTemplate = null;
                                var src = bdiffdata[change][component]['latest']['src'];
                                Object.keys(srcmap).forEach(function(element){
                                    if (src.indexOf(element) == 0) {
                                        commitUrlTemplate = src.replace(element, srcmap[element][0]) + srcmap[element][1]
                                    }
                                })
                                for (var commitIndex in bdiffdata[change][component]['gitlog']) {
                                    var commit = bdiffdata[change][component]['gitlog'][commitIndex]
                                    commit['url'] = commitUrlTemplate + commit['Checksum']
                                }
                            }
                        }
                    });
                }
                if (taskName == 'build') {
                    $http.get(buildRoot + taskName + '/build.json').success(function(bdiffdata) {
                        data['build'] = bdiffdata
                    })
                }
                if (taskName == 'integrationtest') {
                    $http.get(buildRoot + taskName + '/installed-test-results.json').success(function(testdata) {
                        var fulltestname;
                        var total = 0;
                        var failedComponents = [];
                        var failedTestsPerComponent = [];
                        var successful = [];
                        var skipped = [];
                        for (fulltestname in testdata) {
                            var component = fulltestname.split('/')[0];
                            var testname = fulltestname.split('/')[1];
                            total++;
                            var status = testdata[fulltestname];
                            if (status == 'success')
                                successful.push(fulltestname);
                            else if (status == 'failed'){
                                if (failedComponents.indexOf(component) == -1)
                                    failedComponents.push(component);
                                failedTestsPerComponent.push({name: component, test: testname});
                          }
                          else if (status == 'skipped')
                              skipped.push(fulltestname);
                       }
                       data['integrationtest'] = {};
                       data['integrationtest'].total = total;
                       data['integrationtest'].successful = successful;
                       data['integrationtest'].skipped = skipped;
                       data['integrationtest'].failedComponents = failedComponents;
                       data['integrationtest'].failedPerComponent = failedTestsPerComponent;
                    });
                }
                if (taskName == 'applicationstest') {
                    //data['applicationstest'] = buildRoot + taskName;
                    renderApps($http, buildRoot + taskName, function(apps) {
                        data['apps'] = apps;
                    });
                }
                tasks.push(data);
            }).error(function(data, status, headers, config) {
                data = {};
                data['name'] = taskName;
                data['started'] = false;
                data['status'] = '(not found for this build)';
                tasks.push(data);
            });
        });
        tasks.get = function(name) {
            return tasks.filter(function(item){ return item.name == name })
        };
        $scope.tasks = tasks;
    });

    function reversedOrder(a, b) {return parseInt(b)-parseInt(a)}

    bgoControllers.controller('ContinuousHomeCtrl', function($scope, $http, $sce) {
        $scope.builds = [];
        var now = new Date();
        var year = now.getUTCFullYear();
        var month = formatDigits(now.getUTCMonth()+1);
        var day = formatDigits(now.getUTCDate());
        var buildURL = year + "/" + month + '/' + day;
        $http.get(ROOT + 'builds/' + buildURL + '/index.json').success(function(builddata) {
            var builds = builddata['subdirs'].sort(reversedOrder);
            builds.forEach(function(buildID) {
                var build = {}
                build.name = year + month + day + '.' + buildID
                build.failed = []
                build.inprogress = []
                taskNames.forEach(function(task){
                    var url = ROOT + 'builds/' + buildURL + '/' + buildID + '/' + task + '/meta.json'
                    $http.get(url).success(function(taskresult) {
                        if (taskresult['complete'] && !taskresult['success']){
                            build.failed.push(task)
                        }
                        if (!taskresult['complete']){
                            build.inprogress.push(task)
                        }
                    }).error(function(data, status, headers, config) {
                        if (task == 'resolve'){
                            $scope.builds.splice(build, 1);
                        }
                    });
                })
                $scope.builds.push(build)
            });
        });
    });

})(window);
