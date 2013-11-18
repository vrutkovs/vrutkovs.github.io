(function(exports) {
    'use strict';

    var bgoControllers = angular.module('bgoControllers', []);

    var taskNames = ['build', 'smoketest', 'integrationtest', 'applicationstest'];

    var ROOT = '/continuous/buildmaster/';

    var YMD_SERIAL_VERSION_RE = /^(\d+)(\d\d)(\d\d)\.(\d+)$/;

    function relpathToVersion(relpath) {
	var parts = relpath.split('/');
	parts.shift(); // Remove builds/
	return parts[0] + parts[1] + parts[2] + '.' + parts[3];
    };

    function versionToRelpath(version) {
	var match = YMD_SERIAL_VERSION_RE.exec(version);
	return 'builds/' + match[1] + '/' + match[2] + '/' +
	    match[3] + '/' + match[4];
    };

    bgoControllers.controller('ContinuousStatusCtrl', function($scope, $http) {
	console.log("request meta.json");
        $http.get(ROOT + 'results/tasks/build/build/meta.json').success(function(data) {
            $scope.status = data.success ? 'good' : 'bad';
            $scope.buildVersion = relpathToVersion(data.buildName);
	    console.log("scope.buildVersion=" + $scope.buildVersion);
        });
    });

    bgoControllers.controller('ContinuousBuildViewCtrl', function($scope, $http, $routeParams) {
        var buildVersion = $routeParams.buildVersion;
	console.log("buildVersion=" + buildVersion);
        $scope.buildVersion = buildVersion;
        $scope.buildPath = versionToRelpath(buildName);

        var buildRoot = ROOT + $scope.buildPath + '/';

        var tasks = [];
        taskNames.forEach(function(taskName) {
            $http.get(buildRoot + taskName + '/meta.json').success(function(data) {
                // Mangle the data a bit so we can render it better
                data['name'] = taskName;
		data['version'] = relpathToVersion(data['buildName']);
                tasks.push(data);
            });
        });
        $scope.tasks = tasks;

        var apps = [];
        $http.get(buildRoot + 'applicationstest/apps.json').success(function(data) {
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
            $scope.apps = apps;
        });
    });

    bgoControllers.controller('ContinuousHomeCtrl', function($scope, $http) {
        var builds = [];

        // Just get the most recent build for now. We need an
        // API to iterate over all the builds.
        $http.get(ROOT + 'results/tasks/build/build/meta.json').success(function(data) {
            data.buildVersion = relpathToVersion(data.buildName);
            builds.push(data);
        });
        $scope.builds = builds;

        $http.get(ROOT + 'autobuilder-status.json').success(function(status) {
            var text;
            if (status.running.length > 0)
                text = 'Running: ' + status.running.join(' ') + '; load=' + status.systemLoad[0];
            else
                text = 'Idle, awaiting commits';

            $scope.runningState = text;
        });
    });

})(window);
