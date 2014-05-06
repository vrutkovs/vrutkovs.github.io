(function(exports) {
    'use strict';

    var bgoControllers = angular.module('bgoControllers', []);

    var taskNames = ['resolve', 'bdiff', 'build', 'smoketest', 'smoketest-classic', 'smoketest-wayland', 'integrationtest','applicationstest', ];

    var ROOT = 'https://build.gnome.org/continuous/buildmaster/';

    var YMD_SERIAL_VERSION_RE = /^(\d+)(\d\d)(\d\d)\.(\d+)$/;

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
                    })
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
        $scope.tasks = tasks;
    });

    function reversedOrder(a, b) {return parseInt(b)-parseInt(a)}

    bgoControllers.controller('ContinuousHomeCtrl', function($scope, $http, $sce) {
        $scope.builds = [];
        var year = '2014';
        /*$http.get(ROOT + 'builds/2014/index.json').success(function(monthdata) {
            var months = monthdata['subdirs'].sort(reversedOrder);
            months.forEach(function(month) {
                $http.get(ROOT + 'builds/' + year + '/' + month + '/index.json').success(function(daydata) {
                    var days = daydata['subdirs'].sort(reversedOrder);
                    days.forEach(function(day) {
                        $http.get(ROOT + 'builds/' + year + '/' + month + '/' + day + '/index.json').success(function(builddata) {
                            var builds = builddata['subdirs'].sort(reversedOrder);
                            builds.forEach(function(buildID) {
                                $scope.builds.push(year + month + day + '.' + buildID)
                            });
                        });
                    });
                });
            });
        });*/
        $scope.builds.push({'name':"20140101.1", 'failed': ['integrationtest','applicationstest']})
        $scope.builds.push({'name':"20140102.30", 'failed': ['integrationtest']})
        $scope.builds.push({'name':"20140102.71", 'failed': ['build']})
        $scope.builds.push({'name':"20140506.30", 'failed': ['smoketest', 'smoketest-wayland', 'smoketest-classic', 'integrationtest', 'applicationstest']})
        $scope.builds.push({'name':"20140506.40", 'failed': ['smoketest-wayland', 'smoketest-classic', 'integrationtest','applicationstest']})
        $scope.builds.push({'name':"20140506.41", 'failed': ['smoketest', 'smoketest-wayland', 'smoketest-classic','integrationtest','applicationstest']})
    });

})(window);
