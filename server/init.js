'use strict';

const { Network } = require('hollaex-node-lib');
const { all } = require('bluebird');
const rp = require('request-promise');
const { loggerInit } = require('./config/logger');
const { User, Status, Tier } = require('./db/models');

const HE_NETWORK_ENDPOINT = 'https://api.testnet.hollaex.network';
const HE_NETWORK_BASE_URL = '/v2';
const PATH_ACTIVATE = '/exchange/activate';

const { subscriber, publisher } = require('./db/pubsub');
const { INIT_CHANNEL, CONFIGURATION_CHANNEL, WS_HUB_CHANNEL } = require('./constants');
const { each } = require('lodash');

let nodeLib;

const getNodeLib = () => nodeLib;

subscriber.on('message', (channel, message) => {
	if (channel === INIT_CHANNEL) {
		const { type } = JSON.parse(message);
		switch(type) {
			case 'refreshInit':
				checkStatus();
				publisher.publish(
					WS_HUB_CHANNEL,
					JSON.stringify({ action: 'restart' })
				);
				break;
			default:
				break;
		}
	}
	return;
});

subscriber.subscribe(INIT_CHANNEL);

const checkStatus = () => {
	loggerInit.verbose('init/checkStatus', 'checking exchange status');

	let configuration = {
		coins: {},
		pairs: {},
		tiers: {},
		kit: {
			info: {},
			color: {},
			interface: {},
			icons: {},
			links: {},
			strings: {},
			captcha: {},
			defaults: {},
			plugins: {
				configuration: {}
			},
			meta: {}
		}
	};

	let secrets = {
		security: {},
		accounts: {},
		captcha: {},
		emails: {},
		smtp: {},
		plugins: {
			s3: {},
			sns: {},
			freshdesk: {}
		}
	};

	let frozenUsers = {};

	return Status.findOne({})
		.then((status) => {
			loggerInit.info('init/checkStatus');
			if (!status) {
				stop();
				throw new Error('Exchange is not initialized yet');
			} else if (status.blocked) {
				stop();
				throw new Error('Exchange is locked');
			} else if (!status.activation_code) {
				stop();
				throw new Error('Exchange activation code is not set');
			} else if (!status.api_key || !status.api_secret) {
				stop();
				throw new Error('Exchange keys are not set.');
			} else if (!status.activated) {
				stop();
				throw new Error('Exchange is expired');
			} else {
				secrets = status.secrets;
				configuration.kit = status.kit;
				return all([
					checkActivation( // added kit
						status.name,
						status.url,
						status.activation_code,
						status.kit_version,
						status.constants,
						status.kit
					),
					Tier.findAll({ raw: true }),
					status.dataValues
				]);
			}
		})
		.then(([exchange, tiers, status]) => {
			loggerInit.info('init/checkStatus/activation', exchange.name, exchange.active);
			each(tiers, (tier) => {
				configuration.tiers[tier.id] = tier;
			});
			each(exchange.coins, (coin) => {
				configuration.coins[coin.symbol] = coin;
			});
			each(exchange.pairs, (pair) => {
				configuration.pairs[pair.name] = pair;
			});
			configuration.kit.info = {
				name: exchange.name,
				active: exchange.active,
				url: exchange.url,
				is_trial: exchange.is_trial,
				created_at: exchange.created_at,
				expiry: exchange.expiry,
				status: true,
				initialized: status.initialized
			};
			const networkNodeLib = new Network({
				apiKey: status.api_key,
				apiSecret: status.api_secret,
				exchange_id: exchange.id,
				activation_code: exchange.activation_code
			});

			nodeLib = networkNodeLib;

			return all([
				User.findAll({
					where: {
						activated: false
					}
				}),
				networkNodeLib
			]);
		})
		.then(([ users, networkNodeLib ]) => {
			loggerInit.info('init/checkStatus/activation', users.length, 'users deactivated');
			each(users, (user) => {
				frozenUsers[user.dataValues.id] = true;
			});
			publisher.publish(
				CONFIGURATION_CHANNEL,
				JSON.stringify({
					type: 'initial',
					data: { configuration, secrets, frozenUsers }
				})
			);
			loggerInit.info('init/checkStatus/activation complete');
			return networkNodeLib;
		})
		.catch((err) => {
			let message = 'Initialization failed';
			if (err.message) {
				message = err.message;
			}
			if (err.statusCode && err.statusCode === 402) {
				message = err.error.message;
			}
			loggerInit.error('init/checkStatus Error ', message);
			setTimeout(() => { process.exit(1); }, 60 * 1000 * 5);
		});
};

const stop = () => {
	publisher.publish(CONFIGURATION_CHANNEL, JSON.stringify({ type: 'stop' }));
};

const checkActivation = (name, url, activation_code, version, constants = {}, kit = {}) => {
	const body = {
		name,
		url,
		activation_code,
		constants,
		kit
	};
	if (version) {
		// only sends version if its set
		body.version = version;
	}

	const options = {
		method: 'POST',
		body,
		uri: `${HE_NETWORK_ENDPOINT}${HE_NETWORK_BASE_URL}${PATH_ACTIVATE}`,
		json: true
	};
	return rp(options);
};

module.exports = {
	checkStatus,
	checkActivation,
	getNodeLib
};