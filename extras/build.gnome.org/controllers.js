(function(exports) {
    'use strict';

    var bgoControllers = angular.module('bgoControllers', []);

    var taskNames = ['resolve', 'build', 'smoketest', 'integrationtest', 'applicationstest'];

    var ROOT = '/continuous/buildmaster/';

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
        $http.get(ROOT + path + '/applicationstest/apps.json').success(function(data) {
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
        $scope.buildVersion = buildVersion;

	var buildPath = versionToRelpath(buildVersion);
        var buildRoot = ROOT + 'builds/' + buildPath + '/';

        var tasks = [];
        taskNames.forEach(function(taskName) {
            $http.get(buildRoot + taskName + '/meta.json').success(function(data) {
                // Mangle the data a bit so we can render it better
                data['name'] = taskName;
		data['version'] = relpathToVersion(data['buildPath']);
                tasks.push(data);
            }).error(function(data, status, headers, config) {
		data = {};
		data['name'] = taskName;
		data['status'] = '(not found for this build)';
                tasks.push(data);
	    });
        });
        $scope.tasks = tasks;

	renderApps($http, 'builds/' + buildPath, function(apps) {
            $scope.apps = apps;
	});
    });

    function compareTaskData(a, b) {
	var ai = taskNames.indexOf(a['name']);
	var bi = taskNames.indexOf(b['name']);
	return ai - bi;
    }

    bgoControllers.controller('ContinuousHomeCtrl', function($scope, $http) {
        var builds = [];

        $http.get(ROOT + 'autobuilder-status.json').success(function(status) {
            var text;
            if (status.running.length > 0)
                text = 'Running: ' + status.running.join(' ') + '; load=' + status.systemLoad[0];
            else
                text = 'Idle, awaiting commits';

            $scope.runningState = text;
        });

	var now = new Date();
	$scope.pushLogHref = "#/gnome-continuous/log/" + now.getUTCFullYear() + "/" +
	    (now.getUTCMonth()+1) + "/" + now.getUTCDate();

        var completedTasks = [];
        taskNames.forEach(function(taskName) {
	    var href = ROOT + 'results/tasks/' + taskName + '/' + taskName;
            $http.get(href + '/meta.json').success(function(data) {
                // Mangle the data a bit so we can render it better
                data['name'] = taskName;
		data['version'] = relpathToVersion(data['buildPath']);
		data['href'] = ROOT + data['path'];
                completedTasks.push(data);
		completedTasks.sort(compareTaskData);
		$scope[taskName] = data;
            }).error(function(data, status, headers, config) {
		data = {};
		data['name'] = taskName;
		data['status'] = '(none completed)';
                completedTasks.push(data);
		completedTasks.sort(compareTaskData);
	    });
        });
        $scope.completedTasks = completedTasks;

	$http.get(ROOT + '/results/tasks/build/build/build.json').success(function(data) {
	    $scope.buildData = data;
	});

	$http.get(ROOT + '/results/tasks/integrationtest/integrationtest/installed-test-results.json').success(function(data) {
	    var testname;
	    var total = 0;
	    var failed = [];
	    var successful = [];
	    var skipped = [];
	    for (testname in data) {
		total++;
		var status = data[testname];
		if (status == 'success')
		    successful.push(testname);
		else if (status == 'failed')
		    failed.push(testname);
		else if (status == 'skipped')
		    skipped.push(testname);
	    }
	    $scope.installedTestsTotal = total;
	    $scope.installedTestsSuccessful = successful;
	    $scope.installedTestsFailed = failed;
	    $scope.installedTestsSkipped = skipped;
	});

	renderApps($http, 'results/tasks/applicationstest', function(apps) {
            $scope.apps = apps;
	});
    });

    bgoControllers.controller('ContinuousLogCtrl', function($scope, $http, $routeParams) {
        var year = $routeParams.year;
        var month = $routeParams.month;
        var day = $routeParams.day;
	var dayBaseUrl = ROOT + 'builds/' + year + '/' + month + '/' + day + '/';
	var indexPath =  dayBaseUrl + 'index.json';
	var snapshots = [];
	$scope.snapshots = snapshots;
	$scope.commitLimit = 10;
        $http.get(indexPath).success(function(data) {
	    if (data.length == 0)
		return;
	    var children = data['subdirs'];
	    children.sort(function(a,b) { return parseInt(a) - parseInt(b) });
	    for (var i = 0; i < children.length; i++) {
		var baseHref = dayBaseUrl + children[i];
		var version = relpathToVersion('builds/' + year + '/' + month + '/' + day + '/' + children[i]);
		snapshots[i] = {'version': version,
			        'href': baseHref,
			        'bdiff': null,
				'loading': true};
		var bindData = {'snapshots': snapshots, 'i': i};
		$http.get(baseHref + '/bdiff.json').success(function(data) {
		    this.snapshots[this.i].bdiff = data;
		    this.snapshots[this.i].loading = false;
		}.bind(bindData)).error(function() {
		    this.snapshots[this.i].loading = false;
		}.bind(bindData));
	    }
	});
    });

})(window);
