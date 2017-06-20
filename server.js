'use strict';

const url = require('url');

const express = require('express');

// TODO: investigate replacement sesion lib as the connect.session() MemoryStore
// is not designed for prod use and will leak memory not scaling beyond a single process
const session = require('express-session');

const xero = require('xero-node');

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'keyboard cat';

let xeroClient;
let eventReceiver;
let metaConfig = {};

function getXeroClient(session) {

    try {
        metaConfig = require('./config/config.json');
    } catch (ex) {
        if (process && process.env && process.env.APPTYPE) {
            //no config file found, so check the process.env.
            metaConfig.APPTYPE = process.env.APPTYPE;
            metaConfig[metaConfig.APPTYPE.toLowerCase()] = {
                authorizeCallbackUrl: process.env.authorizeCallbackUrl,
                userAgent: process.env.userAgent,
                consumerKey: process.env.consumerKey,
                consumerSecret: process.env.consumerSecret
            }
        } else {
            throw "Config not found";
        }
    }

    if (!xeroClient) {
        const APPTYPE = metaConfig.APPTYPE;
        const config = metaConfig[APPTYPE.toLowerCase()];

        if (session) {
            if (session.oauthAccessToken && session.oauthAccessSecret) {
                config.accessToken = session.oauthAccessToken;
                config.accessSecret = session.oauthAccessSecret;
            }
        }

        if (config.privateKeyPath && !config.privateKey) {
            try {
                //Try to read from the path
                config.privateKey = fs.readFileSync(config.privateKeyPath);
            } catch (ex) {
                //It's not a path, so use the consumer secret as the private key
                config.privateKey = "";
            }
        }


        switch (APPTYPE) {
            case "PUBLIC":
                xeroClient = new xero.PublicApplication(config);
                break;
            case "PARTNER":
                xeroClient = new xero.PartnerApplication(config);
                eventReceiver = xeroClient.eventEmitter;
                eventReceiver.on('xeroTokenUpdate', function(data) {
                    //Store the data that was received from the xeroTokenRefresh event
                    console.log("Received xero token refresh: ", data);
                });
                break;
            default:
                throw "No App Type Set!!"
        }
    }

    return xeroClient;
}

function authorizeRedirect(req, res, returnTo) {
    const xeroClient = getXeroClient(null, returnTo);
    xeroClient.getRequestToken((err, token, secret) => {
        if (!err) {
            req.session.oauthRequestToken = token;
            req.session.oauthRequestSecret = secret;
            req.session.returnTo = returnTo;

            const authoriseUrl = xeroClient.buildAuthorizeUrl(token, { scope: '' });

            res.redirect(authoriseUrl);
        } else {
            res.redirect('/error');
        }
    });
}

function authorizedOperation(req, res, returnTo, callback) {
    if (xeroClient) {
        callback(xeroClient);
    } else {
        authorizeRedirect(req, res, returnTo);
    }
}

function handleErr(err, req, res, returnTo) {
    console.log(err);
    if (err.data && err.data.oauth_problem && err.data.oauth_problem == "token_rejected") {
        authorizeRedirect(req, res, returnTo);
    } else {
        res.redirect('/error');
    }
}

app.use(session({ secret: SESSION_SECRET }));

app.get('/access', (req, res) => {
    const xeroClient = getXeroClient();
    if (req.query.oauth_verifier && req.query.oauth_token == req.session.oauthRequestToken) {
        xeroClient.setAccessToken(req.session.oauthRequestToken, req.session.oauthRequestSecret, req.query.oauth_verifier)
            .then(() => res.redirect(req.session.returnTo || '/'))
            .catch(err => handleErr(err, req, res, '/error'));
    }
});

app.get('/', (req, res) => {
    res.send(`<html><body><h1>Welcome to the OAuth Web Layer</h1><p><a href="/reports">Login</a></p></body></html>`);
});

app.get('/reports', (req, res) => {
    authorizedOperation(req, res, '/reports', xeroClient => {
        res.send(`<html><body><h1>Please select the report you require:</h1><ul><li><a href="/reports/ProfitAndLoss">Profit and Loss</a></li></ul></body></html>`);
    });
});

app.get('/reports/ProfitAndLoss', (req, res) => {
    authorizedOperation(req, res, 'reports/ProfitAndLoss', xeroClient => {
        xeroClient.core.reports.generateReport({ id: 'ProfitAndLoss' })
            .then(report => res.send(report))
            .catch(err => handleErr(err, req, res, '/reports'));
    });
});

app.get('/error', (req, res) => res.json({ error: 'error' }));

app.get('/success', (req, res) => res.json({ success: 'success' }));

app.listen(PORT, () => console.log(`Server running on port ${ PORT }`));