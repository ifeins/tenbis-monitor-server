const axios = require('axios');
const moment = require('moment-timezone');
require('string.prototype.padstart').shim();

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();
const TimeUtils = require('./time-utils');

const TENBIS_API_URL = 'https://www.10bis.co.il/api'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 5_0 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9A334 Safari/7534.48.3'

const DAILY_LUNCH_BUDGET = 40;
const MAX_LUNCH_LIMIT = 150;

const CODE_NO_10BIS_ID = "NO_10BIS_ID";

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  // application specific logging, throwing an error, or other logic here
});

function createService() {
  return axios.create({
    baseURL: TENBIS_API_URL,
    headers: {'User-Agent': USER_AGENT}
  });
}

exports.createUser = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;
  const email = req.body.email;
  const password = req.body.password;

  tenbisLogin(email, password)
    .then(tenbisUser => {
      const docRef = db.collection('users').doc(userId);
      docRef.set({tenbisUid: tenbisUser.EncryptedUserId});
      res.sendStatus(200);
    })
    .catch(error => {
      renderError(res, error);
    })
});

exports.refreshUserData = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;

  const date = moment.tz('Asia/Jerusalem');
  
  fetchMonthlySummary(userId)
    .then(response => {
      const docRef = getReportDocRef(userId, date);
      docRef.set(response.summary);
      response.transactions.forEach(transaction => {
        transaction.date = transaction.date.format();
        docRef.collection('transactions').doc(transaction.id.toString()).set(transaction);
      });
      res.sendStatus(200);
    })
    .catch(err => renderError(res, err));
});

function tenbisLogin(email, password) {
  const service = createService();

  return new Promise((resolve, reject) => {
    const promise = service.get('/login', {
      params: {
        SocialLoginUID: 0, 
        websiteId: '10bis', 
        UserName: email, 
        domainID: '10bis', 
        Password: password
      }
    });

    promise
      .then(response => {
        if (response.data.Success) {
          resolve(response.data.UserData);
        } else {
          reject({status: 401, data: response.data.Error.ErrorDesc});
        }
      })
      .catch(error => {
        if (error.response) {
          reject(error.response);
        } else if (error.request) {
          reject(error.request);
        } else if (error.message) {
          reject(error.message);
        } else {
          reject(error);
        }
      });
  });
}

function getReportDocRef(userId, date) {
  const month = date.month() + 1; // moment returns months that start from 0-11
  const year = date.year();
  const docId = `${month.toString().padStart(2, '0')}-${year}`;
  return db.collection('users').doc(userId).collection('reports').doc(docId);
}

function renderError(res, err) {
  console.log('Rendering error', err);
  if (!err) {
    res.sendStatus(500);
    return;
  }

  if (err.status && err.data) {
    res.status(err.status).send(JSON.stringify(err.data));
  } else {
    res.status(500).send(JSON.stringify(err.toString()));
  }
}

function fetchMonthlySummary(userId) {
  console.log(`Fetching monthly summary for user ${userId}`);
  const service = createService();

  return new Promise((resolve, reject) => {
    fetchTenbisUid(userId)
      .then((tenbisUid) => fetchTransactions(service, tenbisUid))
      .then((transactions) => buildResponse(transactions))
      .then((response) => resolve(response))
      .catch((err) => reject(err));
  });  
}

function fetchTenbisUid(userId) {
  console.log(`Fetching tenbis UID for user ${userId}`);
  return new Promise((resolve, reject) => {
    const docRef = db.collection('users').doc(userId);
    docRef.get()
      .then(doc => {
        if (!doc.exists || !doc.data().tenbisUid) {
          reject({status: 404, data: {message: "Could not find 10bis id", code: CODE_NO_10BIS_ID}});
        } else {
          resolve(doc.data().tenbisUid);
        }
      })
      .catch((err) => reject(err));
  });
}

function fetchTransactions(service, tenbisUid) {
  console.log(`Fetching transactions for tenbis ID: ${tenbisUid}`);
  return new Promise((resolve, reject) => {
    service.get(`UserTransactionsReport?encryptedUserId=${encodeURIComponent(tenbisUid)}&dateBias=0&WebsiteId=10bis&DomainId=10bis`)
      .then((response) => resolve(parseTransactions(response.data.Transactions)))
      .catch((error) => {
        if (error.response) {
          reject(error.response)
        } else {
          reject(error);
        }
      });
  });
}

function parseTransactions(transactionsJson) {
  if (!transactionsJson) return [];

  return transactionsJson.map(entry => {
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
  try {
    date = moment.tz(transactions[0].date, 'Asia/Jerusalem');
    const year = date.year();
    const month = date.month();

    const workDays = TimeUtils.getWorkDays(year, month);
    const monthlyLunchBudget = workDays * DAILY_LUNCH_BUDGET;
    const totalSpent = sumLunchTransactions(transactions);
    const averageLunchSpending = getAverageLunchSpending(totalSpent, transactions);
    const remainingMonthlyLunchBudget = Math.max(0, monthlyLunchBudget - totalSpent);
    const remainingWorkDays = getRemainingWorkDays();
    const todayBudget = getTodayBudget(remainingMonthlyLunchBudget, remainingWorkDays, transactions);
    const nextWorkDayBudget = getNextWorkDayBudget(remainingMonthlyLunchBudget, todayBudget, remainingWorkDays);
    const updatedAt = moment.tz('Asia/Jerusalem').format();

    const response = {
      summary: {
        workDays: workDays,
        monthlyLunchBudget: monthlyLunchBudget.toFixed(2),
        totalSpent: totalSpent.toFixed(2),
        averageLunchSpending: averageLunchSpending.toFixed(2),
        remainingMonthlyLunchBudget: remainingMonthlyLunchBudget.toFixed(2),
        remainingWorkDays: remainingWorkDays,                                
        todayBudget: todayBudget.toFixed(2),
        nextWorkDayBudget: nextWorkDayBudget.toFixed(2),
        updatedAt: updatedAt,
      },
      transactions: transactions,
    }
    
    return Promise.resolve(response);
  } catch (error) {
    return Promise.reject(error);
  }  
}

function parseTransactionDate(transactionDate) {
  const matches = /(\d+)/.exec(transactionDate);
  return moment.tz(parseInt(matches[0]), 'Asia/Jerusalem');
}

function getRemainingWorkDays() {
  let remainingWorkDays = 0;
  let date = moment.tz('Asia/Jerusalem');
  const currentMonth = date.month();
  const holidays = TimeUtils.getMonthHolidays(date.year(), date.month());

  while (date.month() == currentMonth) {
    if (TimeUtils.isWorkDay(holidays, date)) {
      remainingWorkDays++;
    }
    date = date.add(1, 'days').hour(0).minute(0).second(0).millisecond(0);
  }

  return remainingWorkDays;
}

function getAverageLunchSpending(totalSpent, transactions) {
  if (transactions.length === 0) return 0;
  return totalSpent / transactions.length;
}

function getTodayBudget(remainingMonthlyLunchBudget, remainingWorkDays, transactions) {
  if (remainingWorkDays <= 0 || remainingMonthlyLunchBudget <= 0) return 0;

  let date = moment.tz('Asia/Jerusalem');
  const holidays = TimeUtils.getMonthHolidays(date.year(), date.month());
  if (date.hour() >= 17 || !TimeUtils.isWorkDay(holidays, date)) {
    return 0;
  }

  const todayTransactions = transactions.filter(t => t.date.isSame(date, 'day') && t.date.hour() < 17);
  const todayTransactionsSum = todayTransactions.reduce(((sum, t) => sum + t.amount), 0);
  let average = Math.min((remainingMonthlyLunchBudget + todayTransactionsSum) / remainingWorkDays, MAX_LUNCH_LIMIT);

  return Math.max(average - todayTransactionsSum, 0);
}

function getNextWorkDayBudget(remainingMonthlyLunchBudget, todayBudget, remainingWorkDays) {
  if (remainingWorkDays <= 1) return -1;
  if (remainingMonthlyLunchBudget <= 0) return 0;

  let date = moment.tz('Asia/Jerusalem');
  const holidays = TimeUtils.getMonthHolidays(date.year(), date.month());
  if (TimeUtils.isWorkDay(holidays, date)) {
    remainingWorkDays--;
  }

  let average = Math.min((remainingMonthlyLunchBudget - todayBudget) / remainingWorkDays, MAX_LUNCH_LIMIT);
  return average;
}

function sumLunchTransactions(transactions) {
  return transactions
    .filter(t => t.date.hour() < 17)
    .map(t => t.amount)
    .reduce((total, amount) => total + amount);
}
