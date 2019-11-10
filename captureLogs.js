/* eslint-disable import/no-extraneous-dependencies */
/*
Copyright 2019, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const StdOutFixture = require('fixture-stdout');
const fs = require('fs');
// const util = require('util');

class captureLogs {
	// Log object to keep logs in memory and in persistent storage
	// captures and reroutes Homey's this.log (stdout) and this.err (stderr)

	constructor(logName, logLength) {
		this.logArray = [];
		this.logName = logName || 'log';
		this.logLength = logLength || 50;
		this.logFile = `/userdata/${this.logName}.json`;
		this.getLogs();
		this.captureStdOut();
		this.captureStdErr();
		// Homey.app.log('capture is ready :)');
	}

	getLogs() {
		fs.readFile(this.logFile, 'utf8', (err, data) => {
			if (err) {
				Homey.app.error('no logfile available');
				return [];
			}
			try {
				this.logArray = JSON.parse(data);
			} catch (error) {
				Homey.app.error('error parsing logfile: ', error.message);
				return [];
			}
			return this.logArray;
		});
	}

	saveLogs() {
		fs.writeFile(this.logFile, JSON.stringify(this.logArray), (err) => {
			if (err) {
				Homey.app.error('error writing logfile: ', err.message);
			} else {
				Homey.app.log('logfile saved');
			}
		});
	}

	deleteLogs() {
		this.logArray = [];
		fs.unlink(this.logFile, (err) => {
			if (err) {
				Homey.app.error('error deleting logfile: ', err.message);
				return err;
			}
			Homey.app.log('logfile deleted');
			return true;
		});
	}

	captureStdOut() {
		// Capture all writes to stdout (e.g. this.log)
		this.captureStdout = new StdOutFixture({ stream: process.stdout });
		// Homey.app.log('capturing stdout');
		this.captureStdout.capture((string) => {
			if (this.logArray.length >= this.logLength) {
				this.logArray.shift();
			}
			this.logArray.push(string);
			// return false;	// prevent the write to the original stream
		});
		// captureStdout.release();
	}

	captureStdErr() {
		// Capture all writes to stderr (e.g. this.error)
		this.captureStderr = new StdOutFixture({ stream: process.stderr });
		// Homey.app.log('capturing stderr');
		this.captureStderr.capture((string) => {
			if (this.logArray.length >= this.logLength) {
				this.logArray.shift();
			}
			this.logArray.push(string);
			// return false;	// prevent the write to the original stream
		});
		// captureStderr.release();
	}

	releaseStdOut() {
		this.captureStdout.release();
	}

	releaseStdErr() {
		this.captureStderr.release();
	}

}

module.exports = captureLogs;
