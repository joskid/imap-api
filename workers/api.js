'use strict';

const { parentPort } = require('worker_threads');
const Hapi = require('@hapi/hapi');
const Boom = require('@hapi/boom');
const Joi = require('@hapi/joi');
const logger = require('../lib/logger');
const hapiPino = require('hapi-pino');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const qs = require('qs');
const Inert = require('@hapi/inert');
const Vision = require('@hapi/vision');
const HapiSwagger = require('hapi-swagger');
const packageData = require('../package.json');
const pathlib = require('path');

const { redis } = require('../lib/db');
const { Account } = require('../lib/account');
const settings = require('../lib/settings');

// allowed configuration keys
const settingsSchema = {
    webhooks: Joi.string()
        .uri({
            scheme: ['http', 'https'],
            allowRelative: false
        })
        .description('Webhook URL')
};

const addressSchema = Joi.object({
    name: Joi.string()
        .max(256)
        .example('Some Name'),
    address: Joi.string()
        .email({
            ignoreLength: false
        })
        .example('user@example.com')
        .required()
}).label('Address');

// generate a list of boolean values
const settingsQuerySchema = Object.fromEntries(
    Object.keys(settingsSchema).map(key => [
        key,
        Joi.boolean()
            .truthy('Y', 'true', '1')
            .falsy('N', 'false', 0)
            .default(false)
    ])
);

const accountSchema = Joi.object({
    auth: Joi.object({
        user: Joi.string()
            .max(256)
            .required()
            .description('Account username'),
        pass: Joi.string()
            .max(256)
            .required()
            .description('Account password')
    })
        .description('Authentication info')
        .label('Authentication'),
    host: Joi.string()
        .hostname()
        .required()
        .description('Hostname to connect to'),
    port: Joi.number()
        .min(1)
        .max(64 * 1024)
        .required()
        .description('Service port number'),
    secure: Joi.boolean()
        .default(false)
        .description('Should connection use TLS'),
    tls: Joi.object({
        rejectUnauthorized: Joi.boolean()
            .default(true)
            .description('How to treat invalid certificates'),
        minVersion: Joi.string()
            .max(256)
            .description('Minimal TLS version')
    })
        .description('Optional TLS configuration')
        .label('TLS')
});

const failAction = async (request, h, err) => {
    let details = (err.details || []).map(detail => ({ message: detail.message, key: detail.context.key }));

    let error = Boom.boomify(new Error('Invalid input'), { statusCode: 400 });
    error.reformat();
    error.output.payload.fields = details; // Add custom key
    throw error;
};

let callQueue = new Map();
let mids = 0;

async function call(message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response');
            err.statusCode = 504;
            err.code = 'Timeout';
            reject(err);
        }, 10 * 1000);

        callQueue.set(mid, { resolve, reject, timer });

        parentPort.postMessage(
            {
                cmd: 'call',
                mid,
                message
            },
            transferList
        );
    });
}

async function onCommand(command) {
    console.log(command);
    return 444;
}

parentPort.on('message', message => {
    if (message && message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
        let { resolve, reject, timer } = callQueue.get(message.mid);
        clearTimeout(timer);
        callQueue.delete(message.mid);
        if (message.error) {
            let err = new Error(message.error);
            if (message.code) {
                err.code = message.code;
            }
            if (message.statusCode) {
                err.statusCode = message.statusCode;
            }
            return reject(err);
        } else {
            return resolve(message.response);
        }
    }

    if (message && message.cmd === 'call' && message.mid) {
        return onCommand(message.message)
            .then(response => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    response
                });
            })
            .catch(err => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    error: err.message,
                    cod: err.code,
                    statusCode: err.statusCode
                });
            });
    }
});

const init = async () => {
    const server = Hapi.server({
        port: 3000,
        host: 'localhost',
        query: {
            parser: query => qs.parse(query, { depth: 3 })
        }
    });

    const swaggerOptions = {
        swaggerUI: true,
        swaggerUIPath: '/swagger/',
        documentationPage: true,
        documentationPath: '/docs',

        grouping: 'tags',

        info: {
            title: 'IMAP API',
            version: packageData.version,
            contact: {
                name: 'Andris Reinman',
                email: 'andris@kreata.ee'
            }
        }
    };

    await server.register({
        plugin: hapiPino,
        options: {
            instance: logger.child({ component: 'api' }),
            // Redact Authorization headers, see https://getpino.io/#/docs/redaction
            redact: ['req.headers.authorization']
        }
    });

    await server.register([
        Inert,
        Vision,
        {
            plugin: HapiSwagger,
            options: swaggerOptions
        }
    ]);

    server.route({
        method: 'GET',
        path: '/',
        handler: {
            file: pathlib.join(__dirname, '..', 'static', 'index.html')
        }
    });

    server.route({
        method: 'GET',
        path: '/favicon.ico',
        handler: {
            file: pathlib.join(__dirname, '..', 'static', 'favicon.ico')
        }
    });

    server.route({
        method: 'GET',
        path: '/static/{file*}',
        handler: {
            directory: {
                path: pathlib.join(__dirname, '..', 'static')
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/v1/account',

        async handler(request) {
            let accountObject = new Account({ redis, call });

            try {
                return await accountObject.create(request.payload);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Register new account',
            notes: 'Registers new IMAP account to be synced',
            tags: ['api', 'account'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                payload: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),

                    name: Joi.string()
                        .max(256)
                        .required()
                        .description('Display name for the account'),

                    imap: accountSchema.description('IMAP configuration').label('IMAP'),
                    smtp: accountSchema.description('SMTP configuration').label('SMTP')
                }).label('CreateAccount')
            }
        }
    });

    server.route({
        method: 'PUT',
        path: '/v1/account/{account}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.update(request.payload);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Update account info',
            notes: 'Updates account information',
            tags: ['api', 'account'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                }),

                payload: Joi.object({
                    name: Joi.string()
                        .max(256)
                        .description('Display name for the account'),
                    imap: accountSchema.description('IMAP configuration').label('IMAP'),
                    smtp: accountSchema.description('SMTP configuration').label('SMTP')
                }).label('UpdateAccount')
            }
        }
    });

    server.route({
        method: 'DELETE',
        path: '/v1/account/{account}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.delete();
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Remove synced account',
            notes: 'Stop syncing IMAP account and delete cached values',
            tags: ['api', 'account'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/account/{account}/mailboxes',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return { mailboxes: await accountObject.getMailboxListing() };
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },

        options: {
            description: 'List mailboxes',
            notes: 'Lists all available mailboxes',
            tags: ['api', 'mailbox'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/v1/account/{account}/mailbox',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.createMailbox(request.payload.path);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },

        options: {
            description: 'Create mailbox',
            notes: 'Create new mailbox folder',
            tags: ['api', 'mailbox'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                }),

                payload: Joi.object({
                    path: Joi.array()
                        .items(Joi.string().max(256))
                        .description('Mailbox path. Array elements are joined using valid path separator')
                        .label('MailboxPath')
                }).label('CreateMailbox')
            }
        }
    });

    server.route({
        method: 'DELETE',
        path: '/v1/account/{account}/mailbox',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.deleteMailbox(request.query.path);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },

        options: {
            description: 'Delete mailbox',
            notes: 'Delete existing mailbox folder',
            tags: ['api', 'mailbox'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                }),

                query: Joi.object({
                    path: Joi.string()
                        .required()
                        .description('Mailbox folder path to delete')
                        .label('MailboxPath')
                }).label('DeleteMailbox')
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/account/{account}/message/{message}/source',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.getRawMessage(request.params.message);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Download raw message',
            notes: 'Fetches raw message as a stream',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),
                    message: Joi.string()
                        .base64({ paddingRequired: false, urlSafe: true })
                        .max(256)
                        .required()
                        .description('Message ID')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/account/{account}/attachment/{attachment}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.getAttachment(request.params.attachment);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Download attachment',
            notes: 'Fetches attachment file as a stream',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),
                    attachment: Joi.string()
                        .base64({ paddingRequired: false, urlSafe: true })
                        .max(256)
                        .required()
                        .description('Attachment ID')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/account/{account}/message/{message}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.getMessage(request.params.message, request.query);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Get message information',
            notes: 'Returns details of a specific message. By default text content is not included, use textType value to force retrieving text',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                query: Joi.object({
                    maxBytes: Joi.number()
                        .min(0)
                        .max(1024 * 1024 * 1024)
                        .description('Max length of text content'),
                    textType: Joi.string()
                        .lowercase()
                        .valid('html', 'plain', '*')
                        .description('Which text content to return, use * for all. By default text content is not returned.')
                }),

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),
                    message: Joi.string()
                        .base64({ paddingRequired: false, urlSafe: true })
                        .max(256)
                        .required()
                        .description('Message ID')
                })
            }
        }
    });

    server.route({
        method: 'PUT',
        path: '/v1/account/{account}/message/{message}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.updateMessage(request.params.message, request.payload);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Update message',
            notes: 'Update message information. Mainly this means changing message flag values',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),
                    message: Joi.string()
                        .max(256)
                        .required()
                        .description('Message ID')
                }),

                payload: Joi.object({
                    flags: Joi.object({
                        add: Joi.array()
                            .items(Joi.string().max(128))
                            .description('Add new flags')
                            .label('AddFlags'),
                        delete: Joi.array()
                            .items(Joi.string().max(128))
                            .description('Delete specific flags')
                            .label('DeleteFlags'),
                        set: Joi.array()
                            .items(Joi.string().max(128))
                            .description('Override all flags')
                            .label('SetFlags')
                    })
                        .description('Flag updates')
                        .label('FlagUpdate')
                }).label('MessageUpdate')
            }
        }
    });

    server.route({
        method: 'DELETE',
        path: '/v1/account/{account}/message/{message}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.deleteMessage(request.params.message);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Delete message',
            notes: 'Move message to Trash or delete it if already in Trash',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),
                    message: Joi.string()
                        .max(256)
                        .required()
                        .description('Message ID')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/account/{account}/text/{text}',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.getText(request.params.text, request.query);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Retrieve message text',
            notes: 'Retrieves message text',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                query: Joi.object({
                    maxBytes: Joi.number()
                        .min(0)
                        .max(1024 * 1024 * 1024)
                        .description('Max length of text content'),
                    textType: Joi.string()
                        .lowercase()
                        .valid('html', 'plain', '*')
                        .default('*')
                        .description('Which text content to return, use * for all. By default all contents are returned.')
                }),

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID'),
                    text: Joi.string()
                        .base64({ paddingRequired: false, urlSafe: true })
                        .max(256)
                        .required()
                        .description('Message text ID')
                }).label('Text')
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/account/{account}/messages',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });
            try {
                return await accountObject.listMessages(request.query);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'List messages in a folder',
            notes: 'Lists messages in a mailbox folder',
            tags: ['api', 'message'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                }),

                query: Joi.object({
                    path: Joi.string()
                        .required()
                        .description('Mailbox folder path'),
                    page: Joi.number()
                        .min(0)
                        .max(1024 * 1024)
                        .default(0)
                        .description('Page number (zero indexed'),
                    pageSize: Joi.number()
                        .min(1)
                        .max(1000)
                        .default(20)
                        .description('How many entries per page'),
                    search: Joi.object({
                        unseen: Joi.boolean()
                            .truthy('Y', 'true', '1')
                            .falsy('N', 'false', 0)
                            .description('Check if message is unseen or not'),
                        flagged: Joi.boolean()
                            .truthy('Y', 'true', '1')
                            .falsy('N', 'false', 0)
                            .description('Check if message is flagged or not'),
                        answered: Joi.boolean()
                            .truthy('Y', 'true', '1')
                            .falsy('N', 'false', 0)
                            .description('Check if message is answered or not'),
                        draft: Joi.boolean()
                            .truthy('Y', 'true', '1')
                            .falsy('N', 'false', 0)
                            .description('Check if message is a draft'),
                        seq: Joi.string()
                            .max(256)
                            .description('Sequence number range'),
                        uid: Joi.string()
                            .max(256)
                            .description('UID range'),
                        from: Joi.string()
                            .max(256)
                            .description('Match From: header'),
                        to: Joi.string()
                            .max(256)
                            .description('Match To: header'),
                        cc: Joi.string()
                            .max(256)
                            .description('Match Cc: header'),
                        body: Joi.string()
                            .max(256)
                            .description('Match text body'),
                        subject: Joi.string()
                            .max(256)
                            .description('Match message subject'),
                        emailId: Joi.string()
                            .max(256)
                            .description('Match specific Gmail unique email UD'),
                        threadId: Joi.string()
                            .max(256)
                            .description('Match specific Gmail unique thread UD'),
                        headers: Joi.object()
                            .unknown(true)
                            .description('Headers to match against')
                    })
                        .description('Optional search query to limit messages')
                        .label('Search')
                }).label('List')
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/v1/account/{account}/submit',

        async handler(request) {
            let accountObject = new Account({ redis, account: request.params.account, call });

            try {
                return await accountObject.submitMessage(request.payload);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Submit message for delivery',
            notes:
                'Submit message for delivery. If reference message ID is provided then IMAP API adds all headers and flags required for a reply/forward automatically.',
            tags: ['api', 'submit'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                params: Joi.object({
                    account: Joi.string()
                        .max(256)
                        .required()
                        .description('Account ID')
                }),

                payload: Joi.object({
                    reference: Joi.object({
                        message: Joi.string()
                            .base64({ paddingRequired: false, urlSafe: true })
                            .max(256)
                            .required()
                            .example('AAAAAQAACnA')
                            .description('Referenced message ID'),
                        action: Joi.string()
                            .valid('forward', 'reply')
                            .example('reply')
                            .default('reply')
                    })
                        .description('Message reference for reply or forward. This is IMAP API specific ID, not Message-ID header value.')
                        .label('MessageReference'),

                    from: addressSchema.required(),

                    to: Joi.array()
                        .items(addressSchema)
                        .description('List of addresses')
                        .label('AddressList'),

                    cc: Joi.array()
                        .items(addressSchema)
                        .description('List of addresses')
                        .label('AddressList'),

                    bcc: Joi.array()
                        .items(addressSchema)
                        .description('List of addresses')
                        .label('AddressList'),

                    subject: Joi.string()
                        .max(1024)
                        .description('Message subject'),

                    text: Joi.string()
                        .max(5 * 1024 * 1024)
                        .description('Message Text'),
                    html: Joi.string()
                        .max(5 * 1024 * 1024)
                        .description('Message HTML'),

                    attachments: Joi.array()
                        .items(
                            Joi.object({
                                filename: Joi.string()
                                    .max(256)
                                    .example('transparent.gif'),
                                content: Joi.string()
                                    .base64()
                                    .max(5 * 1024 * 1024)
                                    .required()
                                    .example('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=')
                                    .description('Base64 formatted attachment file'),
                                contentType: Joi.string()
                                    .lowercase()
                                    .max(256)
                                    .example('image/gif'),
                                contentDisposition: Joi.string()
                                    .lowercase()
                                    .valid('inline', 'attachment'),
                                cid: Joi.string()
                                    .max(256)
                                    .example('unique-image-id@localhost')
                                    .description('Content-ID value for embedded images'),
                                encoding: Joi.string()
                                    .valid('base64')
                                    .default('base64')
                            }).label('Attachment')
                        )
                        .description('List of attachments')
                        .label('AttachmentList')
                }).label('Message')
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/settings',

        async handler(request) {
            let values = {};
            for (let key of Object.keys(request.query)) {
                if (request.query[key]) {
                    let value = await settings.get(key);
                    values[key] = value;
                }
            }
            return values;
        },
        options: {
            description: 'List specific settings',
            notes: 'List setting values for specific keys',
            tags: ['api', 'settings'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                query: Joi.object(settingsQuerySchema).label('SettingsQuery')
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/v1/settings',

        async handler(request) {
            let updated = [];
            for (let key of Object.keys(request.payload)) {
                let keyUpdated = await settings.set(key, request.payload[key]);
                if (keyUpdated) {
                    updated.push(key);
                }
            }
            return { updated };
        },
        options: {
            description: 'Set setting values',
            notes: 'Set setting values for specific keys',
            tags: ['api', 'settings'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                payload: Joi.object(settingsSchema).label('Settings')
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/v1/verifyAccount',

        async handler(request) {
            try {
                return await verifyAccountInfo(request.payload);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                throw Boom.boomify(err, { statusCode: err.statusCode || 500, decorate: { code: err.code } });
            }
        },
        options: {
            description: 'Verify IMAP and SMTP settings',
            notes: 'Checks if can connect and authenticate using provided account info',
            tags: ['api', 'account'],

            validate: {
                options: {
                    stripUnknown: false,
                    abortEarly: false,
                    convert: true
                },
                failAction,

                payload: Joi.object({
                    imap: accountSchema.description('IMAP configuration'),
                    smtp: accountSchema.description('SMTP configuration')
                }).label('VerifyAccount')
            }
        }
    });

    server.route({
        method: '*',
        path: '/{any*}',
        async handler() {
            throw Boom.notFound('Requested page not found'); // 404
        }
    });

    await server.start();
};

async function verifyAccountInfo(accountData) {
    let response = {};

    if (accountData.imap) {
        try {
            let imapClient = new ImapFlow(
                Object.assign(
                    {
                        verifyOnly: true
                    },
                    accountData.imap
                )
            );

            await new Promise((resolve, reject) => {
                imapClient.on('error', err => {
                    reject(err);
                });
                imapClient
                    .connect()
                    .then(resolve)
                    .catch(reject);
            });

            response.imap = {
                success: !!imapClient.authenticated
            };
        } catch (err) {
            response.imap = {
                success: false,
                error: err.message,
                cod: err.code,
                statusCode: err.statusCode
            };
        }
    }

    if (accountData.smtp) {
        try {
            let smtpClient = nodemailer.createTransport(Object.assign({}, accountData.smtp));
            response.smtp = {
                success: await smtpClient.verify()
            };
        } catch (err) {
            response.smtp = {
                success: false,
                error: err.message,
                cod: err.code,
                statusCode: err.statusCode
            };
        }
    }

    return response;
}

process.on('unhandledRejection', err => {
    logger.error({ msg: 'Unhandled Rejection', err });
    process.exit(1);
});

init().catch(err => {
    logger.error(err);
    setImmediate(() => process.exit(1));
});
