/*
Copyright 2019 - 2024, Robin de Gruijter (gruijter@hotmail.com)

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

const getPriceChart = (prices, startHour = 0) => {
	try {
		if (!Array.isArray(prices)) throw Error('not an array');
		// Convert input data to prices, labels and values
		let values = [...prices];
		if (values.length < 24) values = values.concat(Array(24 - values.length).fill(null));
		const labels = values.map((value, index) => {
			const hour = (startHour + index) % 24;
			return hour.toString().padStart(2, '0');
		});

		// Map color of each bar based on value.
		const sortedPrices = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
		const peaks = [...sortedPrices].slice(0, 4);
		const troughs = [...sortedPrices].reverse().slice(0, 4);
		const backgrounds = values.map((value) => {
			if (value <= 0) {
				return 'rgb(189,44,188)'; // Purple (free energy)
			}
			if (troughs.includes(value)) {
				return 'rgb(0,170,101)'; // Green (relatively cheap)
			}
			if (peaks.includes(value)) {
				return 'rgb(237,95,23)'; // Orange (high price)
			}
			return 'rgb(53,86,81)'; // Dark green (normal price)
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

const getChargeChart = (strategy, startHour = 0, maxChargePower = 2200, maxDischargePower = 1700) => {
	try {
		if (!strategy || !strategy.scheme) throw Error('strategy input is invalid');

		// Convert input data to prices, labels and values
		const scheme = JSON.parse(strategy.scheme);
		// const SoCs = Object.keys(scheme).map((hour) => scheme[hour].soc);
		let prices = Object.keys(scheme).map((hour) => scheme[hour].price);
		if (prices.length < 24) prices = prices.concat(Array(24 - prices.length).fill(null));
		const labels = prices.map((value, index) => {
			const hour = (startHour + index) % 24;
			return hour.toString().padStart(2, '0');
		});

		// Map color of each bar based on dis/charge power.
		const backgrounds = Object.keys(scheme).map((idx) => {
			const hour = scheme[idx];
			if (hour.power < 0) {	// charging
				const chargeEnergy = -hour.power * (hour.duration / 60);
				const g = 255 - 100 * (chargeEnergy / maxChargePower);
				return `rgb(0,${Math.round(g)},0)`; // Green (charging)
			}
			if (hour.power > 0) {	// discharging
				const dischargeEnergy = hour.power * (hour.duration / 60);
				const r = 255 - 100 * (dischargeEnergy / maxDischargePower);
				return `rgb(${Math.round(r)},50,20)`; // darkRed (discharging)
			}
			return 'rgb(210,210,210)'; // grey (no dis/charge)
		});

		// Add a data label to the cheapest and most expensive hour
		const sortedPrices = [...prices].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
		const cheapestIndex = prices.indexOf(sortedPrices[0]);
		const expensiveIndex = prices.indexOf(sortedPrices[sortedPrices.length - 1]);
		const datalabels = prices.map((value, index) => {
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
						data: prices,
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

module.exports = { getPriceChart, getChargeChart };

// // START PRICE TEST HERE
// const testPrices = [0.2186399, 0.2039263, 0.1964727, 0.1902896, 0.1917295, 0.1896604, 0.1927338, 0.18881340000000002,
// 	0.1796779, 0.1580673, 0.1554779, 0.1507589, -0.0635179, 0.0949779, 0.0849107, 0.1244172,
// 	0.1549818, 0.1581641, 0.2054993, 0.2589208, 0.2654306, 0.2655879, 0.26430529999999997, 0.2565129];
// getgetPriceChart(testPrices)
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

// // START CHARGE TEST HERE
// const testStrategy = {
// 	power: 0,
// 	duration: 0,
// 	endSoC: 0,
// 	scheme: '{"0":{"power":1700,"duration":35,"soc":30,"price":0.4854},"1":{"power":0,"duration":0,"soc":30,"price":0.2918},
//	 "2":{"power":0,"duration":0,"soc":30,"price":0.2885},"3":{"power":0,"duration":0,"soc":30,"price":0.2841},
//	 "4":{"power":0,"duration":0,"soc":30,"price":0.2856},"5":{"power":0,"duration":0,"soc":30,"price":0.2937},
//	 "6":{"power":0,"duration":0,"soc":30,"price":0.325},"7":{"power":0,"duration":0,"soc":30,"price":0.3515},
//	 "8":{"power":0,"duration":0,"soc":30,"price":0.3459},"9":{"power":0,"duration":0,"soc":30,"price":0.3206},
//	 "10":{"power":0,"duration":0,"soc":30,"price":0.2977},"11":{"power":0,"duration":0,"soc":30,"price":0.2833},
//	 "12":{"power":-1050,"duration":32,"soc":41,"price":0.2699},"13":{"power":-1050,"duration":60,"soc":60,"price":0.261728},
//	 "14":{"power":-1050,"duration":60,"soc":80,"price":0.2611956},"15":{"power":-1050,"duration":60,"soc":100,"price":0.2697382},
//	 "16":{"power":0,"duration":0,"soc":100,"price":0.2958379},"17":{"power":0,"duration":0,"soc":100,"price":0.3299599},
//	 "18":{"power":765,"duration":60,"soc":85,"price":0.4283329},"19":{"power":1700,"duration":60,"soc":51,"price":0.4895831},
//	 "20":{"power":1700,"duration":60,"soc":18,"price":0.5087132},"21":{"power":885,"duration":60,"soc":0,"price":0.44683379999999995},
//	 "22":{"power":0,"duration":0,"soc":0,"price":0.3645901},"23":{"power":0,"duration":0,"soc":0,"price":0.3232686},
//	 "24":{"power":0,"duration":0,"soc":0,"price":0.31740009999999996},"25":{"power":0,"duration":0,"soc":0,"price":0.30666740000000003},
//	 "26":{"power":0,"duration":0,"soc":0,"price":0.2983184},"27":{"power":0,"duration":0,"soc":0,"price":0.28619419999999995},
//	 "28":{"power":-1050,"duration":60,"soc":20,"price":0.2718799},"29":{"power":-1050,"duration":60,"soc":40,"price":0.2704279},
//	 "30":{"power":0,"duration":0,"soc":40,"price":0.2886989},"31":{"power":0,"duration":0,"soc":40,"price":0.32415190000000005},
//	 "32":{"power":0,"duration":0,"soc":40,"price":0.3211632},"33":{"power":0,"duration":0,"soc":40,"price":0.3151616},
//	 "34":{"power":-1050,"duration":60,"soc":59,"price":0.2767199},"35":{"power":0,"duration":0,"soc":59,"price":0.2807613},
//	 "36":{"power":-1050,"duration":60,"soc":79,"price":0.2765747},"37":{"power":-1050,"duration":11,"soc":82,"price":0.2787164},
//	 "38":{"power":0,"duration":0,"soc":82,"price":0.2905139},"39":{"power":0,"duration":0,"soc":82,"price":0.2961646},
//	 "40":{"power":0,"duration":0,"soc":82,"price":0.3052517},"41":{"power":0,"duration":0,"soc":82,"price":0.3467426},
//	 "42":{"power":765,"duration":60,"soc":67,"price":0.41173170000000003},"43":{"power":1700,"duration":60,"soc":34,"price":0.4762005},
//	 "44":{"power":1700,"duration":60,"soc":0,"price":0.45746970000000003},"45":{"power":0,"duration":0,"soc":0,"price":0.38278850000000003},
//	 "46":{"power":0,"duration":0,"soc":0,"price":0.3484245},"47":{"power":0,"duration":0,"soc":0,"price":0.3130078}}',
// };
// const now = new Date();
// const H0 = now.getHours();
// getChargeChart(testStrategy, H0)
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

// https://documentation.image-charts.com/
