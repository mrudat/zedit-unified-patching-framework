/* global ngapp, xelib, modulePath, moduleService */
// helper variables and functions
const openManagePatchersModal = function(scope) {
    scope.$emit('openModal', 'managePatchers', {
        basePath: `${modulePath}/partials`
    });
};
ngapp.controller('buildPatchesController', function($scope, $q, patcherService, patchBuilder) {
    // helper functions
    let getUsedFileNames = function() {
        let patchFileNames = $scope.patchPlugins.map(function(patchPlugin) {
            return patchPlugin.filename;
        });
        return xelib.GetLoadedFileNames(false).concat(patchFileNames);
    };

    let getNewPatchFilename = function() {
        let usedFileNames = getUsedFileNames(),
            patchFileName = 'Patch.esp',
            counter = 1;
        while (usedFileNames.includes(patchFileName)) {
            patchFileName = `Patch ${++counter}.esp`;
        }
        return patchFileName;
    };

    // scope functions
    $scope.patcherToggled = function(patcher) {
        $scope.settings[patcher.id].enabled = patcher.active;
    };

    $scope.patchFileNameChanged = function(patchPlugin) {
        patchPlugin.patchers.forEach(function(patcher) {
            $scope.settings[patcher.id].patchFileName = patchPlugin.filename;
        });
    };

    $scope.addPatchPlugin = function() {
        $scope.patchPlugins.push({
            filename: getNewPatchFilename(),
            patchers: []
        });
    };

    $scope.removePatchPlugin = (index) => $scope.patchPlugins.splice(index, 1);

    $scope.buildPatchPlugin = function(patchPlugin) {
        patchBuilder.buildPatchPlugins([patchPlugin]);
    };

    $scope.buildAllPatchPlugins = function() {
        patchBuilder.buildPatchPlugins($scope.patchPlugins);
    };

    $scope.updatePatchStatuses = function() {
        $scope.patchPlugins.forEach(function(patch) {
            patch.disabled = patch.patchers.reduce(function(b, patcher) {
                return b || !patcher.active;
            }, false) || !patch.patchers.length || !patch.filename.length;
        });
    };

    // event handlers
    $scope.$on('buildAllPatches', $scope.buildAllPatchPlugins);
    $scope.$on('addPatchPlugin', $scope.addPatchPlugin);
    $scope.$on('itemsReordered', $scope.updatePatchStatuses, true);

    // initialization
    patcherService.updateFilesToPatch();
    $scope.patchPlugins = patcherService.getPatchPlugins();
    $scope.updatePatchStatuses();
});

ngapp.service('idCacheService', function(patcherService) {
    let prepareIdCache = function(patchFile) {
        let cache = patcherService.settings.cache,
            fileName = xelib.Name(patchFile);
        if (!cache.hasOwnProperty(fileName)) cache[fileName] = {};
        return cache[fileName];
    };

    this.cacheRecord = function(patchFile) {
        let idCache = prepareIdCache(patchFile),
            forms = Object.values(idCache),
            nextForm = xelib.GetNextObjectID(patchFile);

        let getNewFormId = function() {
            while (forms.includes(nextForm)) nextForm++;
            forms.push(nextForm);
            return nextForm++;
        };

        return function(rec, id) {
            if (!idCache.hasOwnProperty(id)) idCache[id] = getNewFormId();
            xelib.SetFormID(rec, idCache[id], true, false);
            if (xelib.HasElement(rec, 'EDID')) xelib.SetValue(rec, 'EDID', id);
            return rec;
        };
    };
});
ngapp.directive('ignorePlugins', function() {
    return {
        restrict: 'E',
        scope: {
            patcherId: '@'
        },
        templateUrl: `${modulePath}/partials/ignorePlugins.html`,
        controller: 'ignorePluginsController'
    }
});

ngapp.controller('ignorePluginsController', function($scope, patcherService) {
    // helper functions
    let updateIgnoredFiles = function() {
        patcherSettings.ignoredFiles = $scope.ignoredPlugins
            .filter((item) => { return !item.invalid; })
            .map((item) => { return item.filename; });
    };

    let getValid = function(item, itemIndex) {
        let filename = item.filename,
            isRequired = $scope.requiredPlugins.includes(filename),
            duplicate = $scope.ignoredPlugins.find(function(item, index) {
                return item.filename === filename && index < itemIndex;
            });
        return !isRequired && !duplicate;
    };

    // scope functions
    $scope.toggleExpanded = function() {
        if ($scope.ignoredPlugins.length === 0) return;
        $scope.expanded = !$scope.expanded;
    };

    $scope.addIgnoredPlugin = function() {
        if (!$scope.expanded) $scope.expanded = true;
        $scope.ignoredPlugins.push({ filename: 'Plugin.esp' });
        $scope.onChange();
    };

    $scope.removeIgnoredPlugin = function(index) {
        $scope.ignoredPlugins.splice(index, 1);
        $scope.onChange();
    };

    $scope.onChange = function() {
        $scope.ignoredPlugins.forEach(function(item, index) {
            item.invalid = !getValid(item, index);
        });
        updateIgnoredFiles();
    };

    // initialization
    if (!$scope.patcherId) {
        throw 'ignorePlugins Directive: patcher-id is required.';
    }

    let patcher = patcherService.getPatcher($scope.patcherId),
        patcherSettings = patcherService.settings[$scope.patcherId],
        ignoredFiles = patcherSettings.ignoredFiles;

    $scope.requiredPlugins = patcher.requiredFiles || [];
    $scope.ignoredPlugins = ignoredFiles.map(function (filename) {
        return {filename: filename};
    });
});
ngapp.controller('managePatchersModalController', function($scope, patcherService) {
    // helper functions
    let selectTab = function(tab) {
        $scope.tabs.forEach((tab) => tab.selected = false);
        $scope.currentTab = tab;
        $scope.currentTab.selected = true;
        $scope.onBuildPatchesTab = $scope.currentTab.label === 'Build Patches';
    };

    // initialize scope variables
    $scope.settings = patcherService.settings;
    $scope.tabs = patcherService.getTabs();
    $scope.noPatchers = $scope.tabs.length === 1;
    selectTab($scope.tabs[0]);

    // scope functions
    $scope.closeModal = function() {
        patcherService.saveSettings();
        $scope.$emit('closeModal');
    };

    $scope.onTabClick = function(e, tab) {
        e.stopPropagation();
        if (tab === $scope.currentTab) return;
        selectTab(tab);
    };
});
ngapp.service('patchBuilder', function($rootScope, $timeout, patcherService, patchPluginWorker, errorService, progressService) {
    let cache = {};

    let build = (patchPlugin) => patchPluginWorker.run(cache, patchPlugin);

    let getMaxProgress = function(patchPlugin) {
        return patchPlugin.patchers.filterOnKey('active').mapOnKey('id')
            .map(patcherService.getPatcher)
            .reduce(function(sum, patcher) {
                let numProcessTasks = 3 * patcher.execute.process.length;
                return sum + 2 + numProcessTasks * patcher.filesToPatch.length;
            }, 1);
    };

    let getTotalMaxProgress = function(patchPlugins) {
        return patchPlugins.reduce(function(sum, patchPlugin) {
            return sum + getMaxProgress(patchPlugin);
        }, 0);
    };

    let openProgressModal = function(maxProgress) {
        $rootScope.$broadcast('closeModal');
        progressService.showProgress({
            determinate: true,
            title: 'Running Patchers',
            message: 'Initializing...',
            log: [],
            current: 0,
            max: maxProgress
        });
    };

    let getActivePatchPlugins = function(patchPlugins) {
        return patchPlugins.filter(function(patchPlugin) {
            return !patchPlugin.disabled;
        });
    };

    let progressDone = function(patchPlugins) {
        let n = patchPlugins.length;
        progressService.progressTitle(`${n} patch plugins built successfully`);
        progressService.progressMessage('All Done!');
        progressService.allowClose();
    };

    // public functions
    this.buildPatchPlugins = function(patchPlugins) {
        let activePatchPlugins = getActivePatchPlugins(patchPlugins),
            maxProgress = getTotalMaxProgress(activePatchPlugins);
        if (activePatchPlugins.length === 0) return;
        xelib.CreateHandleGroup();
        openProgressModal(maxProgress);
        $timeout(function() {
            errorService.try(() => activePatchPlugins.forEach(build));
            progressDone(activePatchPlugins);
            cache = {};
            xelib.FreeHandleGroup();
            $rootScope.$broadcast('reloadGUI');
        }, 50);
    };
});
ngapp.service('patcherService', function($rootScope, settingsService) {
    let service = this,
        patchers = [],
        tabs = [{
            label: 'Build Patches',
            templateUrl: `${modulePath}/partials/buildPatches.html`,
            controller: 'buildPatchesController'
        }];

    // private functions
    let getPatcherEnabled = function(patcher) {
        return service.settings[patcher.info.id].enabled;
    };

    let getPatcherDisabled = function(patcher) {
        let requiredFiles = patcher.requiredFiles || [];
        return requiredFiles.subtract(patcher.filesToPatch).length > 0;
    };

    let getDisabledHint = function(patcher) {
        let filesToPatch = patcher.filesToPatch,
            requiredFiles = patcher.requiredFiles || [],
            hint = 'This patcher is disabled because the following required' +
                '\r\nfiles are not available to the patch plugin:';
        requiredFiles.subtract(filesToPatch).forEach(function(filename) {
            hint += `\r\n - ${filename}`;
        });
        return hint;
    };

    let getDefaultSettings = function(patcher) {
        let defaultSettings = patcher.settings.defaultSettings || {};
        return Object.assign({
            patchFileName: 'zPatch.esp',
            ignoredFiles: [],
            enabled: true
        }, defaultSettings);
    };

    let buildSettings = function(settings) {
        let defaults = { cache: {} };
        patchers.forEach(function(patcher) {
            let patcherSettings = {};
            patcherSettings[patcher.info.id] = getDefaultSettings(patcher);
            Object.deepAssign(defaults, patcherSettings);
        });
        return Object.deepAssign(defaults, settings);
    };

    let buildTabs = function() {
        patchers.forEach(function(patcher) {
            if (!patcher.settings.hide) tabs.push(patcher.settings);
        });
    };

    let getFilesToPatchHint = function(patcher) {
        let filesToPatch = patcher.filesToPatch,
            hint = filesToPatch.slice(0, 40).join(', ');
        if (filesToPatch.length > 40) hint += '...';
        return hint.wordwrap();
    };

    let createPatchPlugin = function(patchPlugins, patchFileName) {
        let patchPlugin = { filename: patchFileName, patchers: [] };
        patchPlugins.push(patchPlugin);
        return patchPlugin;
    };

    let getPatchPlugin = function(patcher, patchPlugins) {
        let patcherSettings = service.settings[patcher.info.id],
            patchFileName = patcherSettings.patchFileName;
        return patchPlugins.find(function(patchPlugin) {
            return patchPlugin.filename === patchFileName;
        }) || createPatchPlugin(patchPlugins, patchFileName);
    };

    // public functions
    this.getPatcher = function(id) {
        return patchers.find((patcher) => { return patcher.info.id === id; });
    };

    this.registerPatcher = function(patcher) {
        if (service.getPatcher(patcher.info.id)) return;
        patchers.push(patcher);
    };

    this.updateForGameMode = function(gameMode) {
        patchers = patchers.filter(function(patcher) {
            return patcher.gameModes.includes(gameMode);
        });
    };

    this.loadSettings = function() {
        let profileName = settingsService.currentProfile;
        service.settingsPath = `profiles/${profileName}/patcherSettings.json`;
        let settings = fh.loadJsonFile(service.settingsPath) || {};
        service.settings = buildSettings(settings);
        service.saveSettings();
        buildTabs();
    };

    this.saveSettings = function() {
        fh.saveJsonFile(service.settingsPath, service.settings);
    };

    this.getTabs = function() {
        return tabs.map(function(tab) {
            return {
                label: tab.label,
                templateUrl: tab.templateUrl,
                controller: tab.controller
            };
        });
    };

    this.getFilesToPatch = function(patcher) {
        let patcherSettings = service.settings[patcher.info.id],
            ignored = patcherSettings.ignoredFiles,
            filesToPatch = xelib.GetLoadedFileNames(),
            patchFileName = patcherSettings.patchFileName,
            patchFileIndex = filesToPatch.indexOf(patchFileName);
        if (patchFileIndex > -1) filesToPatch.splice(patchFileIndex);
        if (patcher.getFilesToPatch) patcher.getFilesToPatch(filesToPatch);
        return filesToPatch.subtract(ignored);
    };

    this.updateFilesToPatch = function() {
        patchers.forEach(function(patcher) {
            patcher.filesToPatch = service.getFilesToPatch(patcher);
        });
    };

    this.getPatchPlugins = function() {
        let patchPlugins = [];
        patchers.forEach(function(patcher) {
            let patchPlugin = getPatchPlugin(patcher, patchPlugins),
                disabled = getPatcherDisabled(patcher);
            patchPlugin.patchers.push({
                id: patcher.info.id,
                name: patcher.info.name,
                active: !disabled && getPatcherEnabled(patcher),
                disabled: disabled,
                disabledHint: disabled ? getDisabledHint(patcher) : '',
                filesToPatch: patcher.filesToPatch,
                filesToPatchHint: getFilesToPatchHint(patcher)
            });
        });
        return patchPlugins;
    };
});
ngapp.service('patcherWorker', function(patcherService, progressService, idCacheService) {
    this.run = function(cache, patchFileName, patchFile, patcherInfo) {
        let filesToPatch, patcher, patcherSettings, helpers, locals;

        // helper functions
        let progressMessage = (title) => progressService.progressMessage(title);
        let logMessage = (msg) => progressService.logMessage(msg);
        let addProgress = (num) => progressService.addProgress(num);

        let patcherProgress = function(message) {
            addProgress(1);
            progressMessage(message);
        };

        let getFile = function(filename) {
            if (!cache[filename])
                cache[filename] = { handle: xelib.FileByName(filename) };
            return cache[filename];
        };

        let getRecords = function(filename, search, overrides) {
            let file = getFile(filename),
                cacheKey = `${search}_${+overrides}`;
            if (!file[cacheKey])
                file[cacheKey] = xelib.GetRecords(file.handle, search, overrides);
            return file[cacheKey];
        };

        let getRecordsContext = function(signature, filename) {
            let recordType = xelib.NameFromSignature(signature);
            return `${recordType} records from ${filename}`;
        };

        let loadRecords = function(filename, signature, recordsContext) {
            patcherProgress(`Loading ${recordsContext}.`);
            return getRecords(filename, signature, false).map(function(record) {
                return xelib.GetPreviousOverride(record, patchFile);
            });
        };

        let filterRecords = function(records, filterFn, recordsContext) {
            patcherProgress(`Filtering ${records.length} ${recordsContext}`);
            return filterFn ? records.filter(filterFn) : records;
        };

        let getRecordsToPatch = function(loadFn, filename) {
            let plugin = getFile(filename),
                loadOpts = loadFn(plugin.handle, helpers, patcherSettings, locals);
            if (!loadOpts) {
                addProgress(2);
                return [];
            }
            let signature = loadOpts.signature,
                recordsContext = getRecordsContext(signature, filename),
                records = loadRecords(filename, signature, recordsContext);
            return filterRecords(records, loadOpts.filter, recordsContext);
        };

        let patchRecords = function(patchFn, filename, recordsToPatch) {
            let signature = xelib.Signature(recordsToPatch[0]),
                recordsContext = getRecordsContext(signature, filename);
            patcherProgress(`Patching ${recordsToPatch.length} ${recordsContext}`);
            recordsToPatch.forEach(function(record) {
                let patchRecord = xelib.CopyElement(record, patchFile, false);
                patchFn(patchRecord, helpers, patcherSettings, locals);
            });
        };

        let getPatcherHelpers = function() {
            let loadRecords = function(search, includeOverrides = false) {
                return filesToPatch.reduce(function(records, fn) {
                    return records.concat(getRecords(fn, search, includeOverrides));
                }, []);
            };
            return {
                loadRecords: loadRecords,
                allSettings: patcherService.settings,
                logMessage: logMessage,
                cacheRecord: idCacheService.cacheRecord(patchFile)
            };
        };

        let executeBlock = function(processBlock) {
            let loadFn = processBlock.load,
                patchFn = processBlock.patch;
            filesToPatch.forEach(function(filename) {
                let recordsToPatch = getRecordsToPatch(loadFn, filename);
                if (recordsToPatch.length === 0) {
                    addProgress(1);
                    return;
                }
                patchRecords(patchFn, filename, recordsToPatch);
            });
        };

        let initialize = function(exec) {
            patcherProgress('Initializing...');
            if (!exec.initialize) return;
            exec.initialize(patchFile, helpers, patcherSettings, locals);
        };

        let process = function(exec) {
            if (!exec.process) return;
            exec.process.forEach(function(processBlock) {
                executeBlock(processBlock);
            });
        };

        let finalize = function(exec) {
            patcherProgress('Finalizing...');
            if (!exec.finalize) return;
            exec.finalize(patchFile, helpers, patcherSettings, locals);
        };

        let patcherId = patcherInfo.id;
        filesToPatch = patcherInfo.filesToPatch;
        patcher = patcherService.getPatcher(patcherId);
        patcherSettings = patcherService.settings[patcherId];
        helpers = getPatcherHelpers();
        locals = {};

        initialize(patcher.execute);
        process(patcher.execute);
        finalize(patcher.execute);
    };
});
ngapp.service('patchPluginWorker', function(progressService, patcherWorker) {
    this.run = function(cache, patchPlugin) {
        let start = new Date();

        let progressTitle = function(title) {
            progressService.progressTitle(title);
        };

        let patcherProgress = function(message) {
            progressService.addProgress(1);
            progressService.progressMessage(message);
        };

        let preparePatchFile = function(filename) {
            if (!xelib.HasElement(0, filename)) {
                let dataPath = xelib.GetGlobal('DataPath');
                fh.jetpack.cwd(dataPath).remove(filename);
            }
            let patchFile = xelib.AddElement(0, filename);
            xelib.NukeFile(patchFile);
            xelib.AddAllMasters(patchFile);
            return patchFile;
        };

        let cleanPatchFile = function(patchFile) {
            patcherProgress('Removing ITPOs and cleaning masters.');
            try {
                xelib.RemoveIdenticalRecords(patchFile, false, true);
            } catch (x) {
                progressService.logMessage('Removing ITPOs failed: ' + x.message);
            }
            xelib.CleanMasters(patchFile);
        };

        // MAIN WORKER EXECUTION
        let patchFileName = patchPlugin.filename,
            patchFile = preparePatchFile(patchFileName);
        patchPlugin.patchers.forEach(function(patcher) {
            if (!patcher.active) return;
            progressTitle(`Building ${patchFileName} ~ Running ${patcher.name}`);
            patcherWorker.run(cache, patchFileName, patchFile, patcher);
        });
        cleanPatchFile(patchFile);
        console.log(`Generated ${patchFileName} in ${new Date() - start}ms`);
    };
});
ngapp.controller('upfOverviewController', function($scope) {
    $scope.games = xelib.games;
    $scope.upfPages = [
        'Development/APIs/UPF Patcher API',
        'Modal Views/Manage Patchers Modal',
        'Modules/Patcher Modules',
        'Modal Views/Settings Modal/UPF Settings Tab'
    ].map(function(path) {
        return {
            label: path.split('/').last(),
            path: path
        };
    });
});

ngapp.controller('upfPatcherApiController', function($scope) {
    ['patcherSchema', 'patcherHelpers'].forEach(function(label) {
        let path = `modules/${info.id}/docs/${label}.json`;
        $scope[label] = fh.loadJsonFile(path);
    });
});

ngapp.controller('patcherModulesController', function($scope) {
    let path = `modules/${info.id}/docs/patcherVariables.json`;
    $scope.patcherVariables = fh.loadJsonFile(path);
});

let topics = [{
    path: 'Modules/Core Modules',
    topic: {
        label: 'Unified Patching Framework',
        templateUrl: `${modulePath}/docs/overview.html`,
        controller: 'upfOverviewController'
    }
}, {
    path: 'Modules',
    topic: {
        label: 'Patcher Modules',
        templateUrl: `${modulePath}/docs/patcherModules.html`,
        controller: 'patcherModulesController'
    }
}, {
    path: 'Modal Views',
    topic: {
        label: 'Manage Patchers Modal',
        templateUrl: `${modulePath}/docs/managePatchersModal.html`,
        children: [{
            label: 'Build Patches Tab',
            templateUrl: `${modulePath}/docs/buildPatches.html`
        }]
    }
}, {
    path: 'Modal Views/Settings Modal',
    topic: {
        label: 'UPF Settings Tab',
        templateUrl: `${modulePath}/docs/upfSettings.html`
    }
}, {
    path: 'Development/APIs',
    topic: {
        label: 'UPF Patcher API',
        templateUrl: `${modulePath}/docs/api.html`,
        controller: 'upfPatcherApiController'
    }
}];

ngapp.run(function(helpService) {
    topics.forEach(({path, topic}) => helpService.addTopic(topic, path));
});
ngapp.controller('upfSettingsController', function($timeout, $scope) {
    $scope.bannerStyle = {
        'background': `url('${modulePath}/images/banner.jpg')`,
        'background-size': 'cover'
    };

    $scope.managePatchers = function() {
        $scope.saveSettings(false);
        $timeout(() => openManagePatchersModal($scope));
    };
});
// add manage patchers context menu item to tree view context menu
ngapp.run(function(contextMenuFactory) {
    let menuItems = contextMenuFactory.treeViewItems,
        automateIndex = menuItems.findIndex((item) => { return item.id === 'Automate'; });
    menuItems.splice(automateIndex + 1, 0, {
        id: 'Manage Patchers',
        visible: () => { return true; },
        build: (scope, items) => {
            items.push({
                label: 'Manage Patchers',
                hotkey: 'Ctrl+Shift+P',
                callback: () => openManagePatchersModal(scope)
            });
        }
    });
});

// register settings tab
ngapp.run(function(settingsService) {
    settingsService.registerSettings({
        appModes: ['edit'],
        label: 'Unified Patching Framework',
        templateUrl: `${modulePath}/partials/settings.html`,
        controller: 'upfSettingsController'
    });
});

// register hotkey
ngapp.run(function(hotkeyFactory) {
    hotkeyFactory.addHotkeys('editView', {
        p: [{
            modifiers: ['ctrlKey', 'shiftKey'],
            callback: openManagePatchersModal
        }]
    });
});

// register button
let managePatchersButton = {
    class: 'fa fa-puzzle-piece',
    title: 'Manage Patchers',
    hidden: true,
    onClick: (scope) => openManagePatchersModal(scope)
};
ngapp.run(function(buttonFactory) {
    buttonFactory.buttons.unshift(managePatchersButton);
});

// register for events
ngapp.run(function($rootScope, patcherService) {
    $rootScope.$on('sessionStarted', function(e, selectedProfile) {
        patcherService.updateForGameMode(selectedProfile.gameMode);
    });

    $rootScope.$on('filesLoaded', function() {
        if ($rootScope.appMode !== 'edit') return;
        patcherService.loadSettings();
        $rootScope.$applyAsync(() => managePatchersButton.hidden = false);
    });
});

// register deferred module loader
moduleService.deferLoader('UPF');
ngapp.run(function(patcherService) {
    moduleService.registerLoader('UPF', function(module, fh) {
        Function.execute({
            registerPatcher: patcherService.registerPatcher,
            fh: fh,
            info: module.info,
            patcherPath: module.path
        }, module.code);
    });
});