/// <reference path="typings/tsd.d.ts" />

/// <reference path="src/exec.ts" />

/// <reference path="src/file.ts" />
/// <reference path="src/tsc.ts" />
/// <reference path="src/timer.ts" />
/// <reference path="src/util.ts" />

/// <reference path="src/index.ts" />
/// <reference path="src/changes.ts" />

/// <reference path="src/printer.ts" />
/// <reference path="src/reporter/reporter.ts" />

/// <reference path="src/suite/suite.ts" />
/// <reference path="src/suite/syntax.ts" />
/// <reference path="src/suite/testEval.ts" />
/// <reference path="src/suite/tscParams.ts" />

module DT {
	require('source-map-support').install();

	// hacky typing
	var Lazy: LazyJS.LazyStatic = require('lazy.js');
	var Promise: typeof Promise = require('bluebird');

	var fs = require('fs');
	var path = require('path');
	var assert = require('assert');

	var tsExp = /\.ts$/;

	export var DEFAULT_TSC_VERSION = '0.9.1.1';

	/////////////////////////////////
	// Single test
	/////////////////////////////////
	export class Test {
		constructor(public suite: ITestSuite, public tsfile: File, public options?: TscExecOptions) {
		}

		public run(): Promise<TestResult> {
			return Tsc.run(this.tsfile.filePathWithName, this.options).then((execResult: ExecResult) => {
				var testResult = new TestResult();
				testResult.hostedBy = this.suite;
				testResult.targetFile = this.tsfile;
				testResult.options = this.options;

				testResult.stdout = execResult.stdout;
				testResult.stderr = execResult.stderr;
				testResult.exitCode = execResult.exitCode;

				return testResult;
			});
		}
	}

	/////////////////////////////////
	// Test results
	/////////////////////////////////
	export class TestResult {
		hostedBy: ITestSuite;
		targetFile: File;
		options: TscExecOptions;

		stdout: string;
		stderr: string;
		exitCode: number;

		public get success(): boolean {
			return this.exitCode === 0;
		}
	}

	export interface ITestRunnerOptions {
		tscVersion:string;
		findNotRequiredTscparams?:boolean;
	}

	/////////////////////////////////
	// The main class to kick things off
	/////////////////////////////////
	export class TestRunner {
		private timer: Timer;
		private suites: ITestSuite[] = [];

		public changes: GitChanges;
		public index: FileIndex;
		public print: Print;

		constructor(public dtPath: string, public options: ITestRunnerOptions = {tscVersion: DT.DEFAULT_TSC_VERSION}) {
			this.options.findNotRequiredTscparams = !!this.options.findNotRequiredTscparams;

			this.index = new FileIndex(this, this.options);
			this.changes = new GitChanges(this);

			this.print = new Print(this.options.tscVersion);
		}

		public addSuite(suite: ITestSuite): void {
			this.suites.push(suite);
		}

		public checkAcceptFile(fileName: string): boolean {
			var ok = tsExp.test(fileName);
			ok = ok && fileName.indexOf('_infrastructure') < 0;
			ok = ok && fileName.indexOf('node_modules/') < 0;
			ok = ok && /^[a-z]/i.test(fileName);
			return ok;
		}

		public run(): Promise<boolean> {
			this.timer = new Timer();
			this.timer.start();

			this.print.printChangeHeader();

			// only includes .d.ts or -tests.ts or -test.ts or .ts
			return this.index.readIndex().then(() => {
				return this.changes.readChanges();
			}).then((changes: string[]) => {
				this.print.printAllChanges(changes);
				return this.index.collectDiff(changes);
			}).then(() => {
				this.print.printRemovals(this.index.removed);
				this.print.printRelChanges(this.index.changed);
				return this.index.parseFiles();
			}).then(() => {
				// this.print.printRefMap(this.index, this.index.refMap);

				if (Lazy(this.index.missing).some((arr: any[]) => arr.length > 0)) {
					this.print.printMissing(this.index, this.index.missing);
					this.print.printBoldDiv();
					// bail
					return Promise.cast(false);
				}
				// this.print.printFiles(this.files);
				return this.index.collectTargets().then((files) => {
					this.print.printQueue(files);

					return this.runTests(files);
				}).then(() => {
					return !this.suites.some((suite) => {
						return suite.ngTests.length !== 0
					});
				});
			});
		}

		private runTests(files: File[]): Promise<boolean> {
			return Promise.attempt(() => {
				assert(Array.isArray(files), 'files must be array');

				var syntaxChecking = new SyntaxChecking(this.options);
				var testEval = new TestEval(this.options);

				if (!this.options.findNotRequiredTscparams) {
					this.addSuite(syntaxChecking);
					this.addSuite(testEval);
				}

				return Promise.all([
					syntaxChecking.filterTargetFiles(files),
					testEval.filterTargetFiles(files)
				]);
			}).spread((syntaxFiles, testFiles) => {
				this.print.init(syntaxFiles.length, testFiles.length, files.length);
				this.print.printHeader();

				if (this.options.findNotRequiredTscparams) {
					this.addSuite(new FindNotRequiredTscparams(this.options, this.print));
				}

				return Promise.reduce(this.suites, (count, suite: ITestSuite) => {
					suite.testReporter = suite.testReporter || new DefaultTestReporter(this.print);

					this.print.printSuiteHeader(suite.testSuiteName);

					return suite.filterTargetFiles(files).then((targetFiles) => {
						return suite.start(targetFiles, (testResult, index) => {
							this.print.printTestComplete(testResult, index);
						});
					}).then((suite) => {
						this.print.printSuiteComplete(suite);
						return count++;
					});
				}, 0);
			}).then((count) => {
				this.timer.end();
				this.finaliseTests(files);
			});
		}

		private finaliseTests(files: File[]): void {
			var testEval: TestEval = Lazy(this.suites).filter((suite) => {
				return suite instanceof TestEval;
			}).first();

			if (testEval) {
				var existsTestTypings: string[] = Lazy(testEval.testResults).map((testResult) => {
					return testResult.targetFile.dir;
				}).reduce((a: string[], b: string) => {
					return a.indexOf(b) < 0 ? a.concat([b]) : a;
				}, []);

				var typings: string[] = Lazy(files).map((file) => {
					return file.dir;
				}).reduce((a: string[], b: string) => {
					return a.indexOf(b) < 0 ? a.concat([b]) : a;
				}, []);

				var withoutTestTypings: string[] = typings.filter((typing) => {
					return existsTestTypings.indexOf(typing) < 0;
				});

				this.print.printDiv();
				this.print.printTypingsWithoutTest(withoutTestTypings);
			}

			this.print.printDiv();
			this.print.printTotalMessage();

			this.print.printDiv();
			this.print.printElapsedTime(this.timer.asString, this.timer.time);

			this.suites.filter((suite: ITestSuite) => {
				return suite.printErrorCount;
			}).forEach((suite: ITestSuite) => {
				this.print.printSuiteErrorCount(suite.errorHeadline, suite.ngTests.length, suite.testResults.length);
			});
			if (testEval) {
				this.print.printSuiteErrorCount('Without tests', withoutTestTypings.length, typings.length, true);
			}

			this.print.printDiv();

			if (this.suites.some((suite) => {
				return suite.ngTests.length !== 0
			})) {
				this.print.printErrorsHeader();

				this.suites.filter((suite) => {
					return suite.ngTests.length !== 0;
				}).forEach((suite) => {
					suite.ngTests.forEach((testResult) => {
						this.print.printErrorsForFile(testResult);
					});
					this.print.printBoldDiv();
				});
			}
		}
	}

	var dtPath = path.resolve(path.dirname((module).filename), '..', '..');
	var findNotRequiredTscparams = process.argv.some(arg => arg == '--try-without-tscparams');
	var tscVersionIndex = process.argv.indexOf('--tsc-version');
	var tscVersion = DEFAULT_TSC_VERSION;

	if (tscVersionIndex > -1) {
		tscVersion = process.argv[tscVersionIndex + 1];
	}

	var runner = new TestRunner(dtPath, {
		tscVersion: tscVersion,
		findNotRequiredTscparams: findNotRequiredTscparams
	});
	runner.run().then((success) => {
		if (!success) {
			process.exit(1);
		}
	}).catch((err) => {
		throw err;
		process.exit(2);
	});
}
