const axios = require('axios');
const moment = require('moment');
require('moment-timezone');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

const TENBIS_API_URL = 'https://www.10bis.co.il/api'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 5_0 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9A334 Safari/7534.48.3'

const DAILY_LUNCH_BUDGET = 40;

function createService() {
  return axios.create({
    baseURL: TENBIS_API_URL,
    headers: {'User-Agent': USER_AGENT}
  });
}

exports.updateUser = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;  
  const phone = req.body.phone;

  const docRef = db.collection('users').document(userId);
  docRef.set({phone: phone});

  res.sendStatus(200);
});

exports.tenbisLogin = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;
  const email = req.body.email;
  const password = req.body.password;

  const service = createService();

  service.get('/login')
    .then((response) => {
      const tenbisUid = response.data.UserData.EncryptedUserId;
      const docRef = db.collection('users').document(userId);
      docRef.set({tenbisUid: tenbisUid});
      res.sendStatus(200);
    })
    .catch((error) => {
      if (error.response) {
        res.status(error.response.status).send(error.response.data);
      } else if (error.request) {
        console.log(error.request);
        res.sendStatus(500);
      } else {
        console.log(error.message);
        res.sendStatus(500);
      }
    });
});

exports.getTransactions = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;

  const service = createService();

  fetchTenbisUid(userId)
    .then(tenbisUid => fetchTransactions(tenbisUid))
    .then(transactions => res.status(200).send(buildResponse(transactions)))
    .catch((status, data) => {
      res.status(status).send(data);
      return;
    });
});

function fetchTenbisUid(userId) {
  return new Promise((resolve, reject) => {
    const docRef = db.collection('users').document(userId);
    docRef.get()
      .then(doc => {
        if (!doc.exists) {
          reject(404, "Could not find document");
        } else {
          resolve(doc.data().tenbisUid);
        }
      });
  });
}

function fetchTransactions(tenbisUid) {
  return new Promise((resolve, reject) => {
    service.get(`UserTransactionsReport?encryptedUserId=${tenbisUid}&dateBias=0&WebsiteId=10bis&DomainId=10bis`)
      .then(response => {
        resolve(parseTransactions(response.data.Transactions));
      })
      .catch(error => {
        reject(error.response.status, error.response.data);
      });
  });
}

function parseTransactions(transactionsJson) {
  transactionsJson.map(entry => {
    return {
      id: entry.TransactionId,
      date: parseTransactionDate(entry.TransactionDate),
      restaurantName: entry.ResName,
      restaurantLogoUrl: entry.ResLogoUrl,
      amount: entry.TransactionAmount,
      orderType: entry.TransactionType,
      paymentMethod: entry.PaymentMethod,
    }
  });
}

function buildResponse(transactions) {
  return {
    summary: {
      workDays: getWorkDays(),
      remainingWorkDays: getRemainingWorkDays(),
      monthlyLunchBudget: getWorkDays() * DAILY_LUNCH_BUDGET,
      remainingMonthlyLunchBudget: getRemainingMonthlyLunchBudget(),
      averageLunchSpending: getAverageLunchSpending(),
      remainingAverageLunchSpending: getRemainingAverageLunchSpending(),
    },
    transactions: transactions,
  }
}

function parseTransactionDate(transactionDate) {
  const matches = /(\d+)/.exec(transactionDate);
  return moment.tz(parseInt(matches[0]), 'Asia/Jerusalem').format();
}

function getWorkDays() {

}

function getRemainingWorkDays() {

}