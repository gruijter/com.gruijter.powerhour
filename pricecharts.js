/*
Copyright 2019 - 2023, Robin de Gruijter (gruijter@hotmail.com)

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

const querystring = require('querystring');
// const util = require('util');

const defaultHost = 'image-charts.com';
const chartEP = '/chart.js/2.8.0?';

const getChart = (prices) => {
	try {
		if (!Array.isArray(prices)) throw Error('not an array');
		// Convert input data to prices, labels and values
		let values = [...prices];
		if (values.length < 24) values = values.concat(Array(24 - values.length).fill(null));
		const labels = values.map((value, index) => index.toString().padStart(2, '0'));

		// console.log('labels:', labels);
		// console.log('values:', values);

		// Map color of each bar based on value.
		const sortedPrices = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
		const peaks = [...sortedPrices].slice(0, 4);
		const troughs = [...sortedPrices].reverse().slice(0, 4);
		const backgrounds = values.map((value) => {
			if (value <= 0) {
				return 'rgb(189, 44, 188)'; // Purple (free energy)
			}
			if (troughs.includes(value)) {
				return 'rgb(0, 170, 101)'; // Green (relatively cheap)
			}
			if (peaks.includes(value)) {
				return 'rgb(237, 95, 23)'; // Orange (high price)
			}
			return 'rgb(53, 86, 81)'; // Dark green (normal price)
		});

		// Add a data label to the cheapest and most expensive hour
		const cheapestIndex = values.indexOf(troughs[0]);
		const expensiveIndex = values.indexOf(peaks[0]);
		const datalabels = values.map((value, index) => {
			if (index === cheapestIndex || index === expensiveIndex) {
				return [`${value.toFixed(2)}`];
			}
			return [];
		});

		// Build configuration for the chart
		const height = 320;
		const width = 427; // 540;
		const chart = {
			type: 'bar',
			data: {
				labels,
				datasets: [
					{
						label: 'Prices',
						backgroundColor: backgrounds,
						data: values,
					},
				],
			},
			options: {
				responsive: true,
				legend: {
					position: 'none',
				},
				layout: {
					padding: {
						top: 35,
						bottom: 0,
						left: 5,
						right: 5,
					},
				},
				rectangleRadius: 6,
				plugins: {
					datalabels: {
						anchor: 'end',
						align: 'start',
						offset: -40,
						padding: 5,
						backgroundColor: backgrounds,
						color: 'white',
						borderWidth: 2,
						borderColor: 'white',
						borderRadius: 100,
						font: {
							size: 14,
						},
					},
				},
				datalabels,
			},
		};

		const query = {
			bkg: 'white',
			height,
			width,
			c: JSON.stringify(chart),
		};
		const path = chartEP + querystring.stringify(query);
		const url = `https://${defaultHost}${path}`;
		return Promise.resolve(url);
	} catch (error) {
		return Promise.reject(error);
	}
};

module.exports = { getChart };

// // START TEST HERE
// const testPrices = [0.2186399, 0.2039263, 0.1964727, 0.1902896, 0.1917295, 0.1896604, 0.1927338, 0.18881340000000002,
// 	0.1796779, 0.1580673, 0.1554779, 0.1507589, -0.0635179, 0.0949779, 0.0849107, 0.1244172,
// 	0.1549818, 0.1581641, 0.2054993, 0.2589208, 0.2654306, 0.2655879, 0.26430529999999997, 0.2565129];
// getChart(testPrices)
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

// https://documentation.image-charts.com/
