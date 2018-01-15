const axios = require('axios');
const moment = require('moment');
require('moment-timezone');

const Hebcal = require('hebcal');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

const TENBIS_API_URL = 'https://www.10bis.co.il/api'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 5_0 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9A334 Safari/7534.48.3'

const DAILY_LUNCH_BUDGET = 40;

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
  const tenbisUid = req.body.tenbisUid;

  const service = createService();

  fetchTenbisUid(userId, tenbisUid)
    .then(tenbisUid => fetchTransactions(service, tenbisUid))
    .then(transactions => buildResponse(transactions))
    .then(response => res.status(200).send(response))
    .catch(err => {
      console.log(err);
      if (err.status && err.data) {
        res.status(err.status).send(JSON.stringify(err.data.toJSON()));
      } else {
        res.status(500).send(JSON.stringify(err.toJSON()));
      }
    });
});

function fetchTenbisUid(userId, tenbisUid) {
  if (tenbisUid) {
    return Promise.resolve(tenbisUid);
  }

  return new Promise((resolve, reject) => {
    const docRef = db.collection('users').document(userId);
    docRef.get()
      .then(doc => {
        if (!doc.exists) {
          reject({status: 404, data: "Could not find document"});
        } else {
          resolve(doc.data().tenbisUid);
        }
      })
      .catch(err => Promise.reject(err));
  });
}

function fetchTransactions(service, tenbisUid) {
  return new Promise((resolve, reject) => {
    service.get(`UserTransactionsReport?encryptedUserId=${tenbisUid}&dateBias=0&WebsiteId=10bis&DomainId=10bis`)
      .then(response => resolve(parseTransactions(response.data.Transactions)))
      .catch(error => reject(error.response));
  });
}

function parseTransactions(transactionsJson) {
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

    const workDays = getWorkDays(year, month);
    const remainingLunches = getRemainingLunches(transactions);
    const monthlyLunchBudget = workDays * DAILY_LUNCH_BUDGET;
    const totalSpent = sumLunchTransactions(transactions);
    const remainingMonthlyLunchBudget = monthlyLunchBudget - totalSpent;
    const averageLunchSpending = totalSpent / transactions.length;
    const remainingAverageLunchSpending = remainingMonthlyLunchBudget / remainingLunches;

    const response = {
      summary: {
        workDays: workDays,
        remainingLunches: remainingLunches,
        monthlyLunchBudget: monthlyLunchBudget,
        totalSpent: totalSpent,
        remainingMonthlyLunchBudget: remainingMonthlyLunchBudget,
        averageLunchSpending: averageLunchSpending,
        remainingAverageLunchSpending: remainingAverageLunchSpending,
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

function getWorkDays(year, month) {
  let date = moment([year, month, 1]);
  let workDays = 0;

  // as long as we haven't moved to the next month
  while (date.month() == month) {
    if (date.day() < 5) { // Fri: 5, Sat: 6
      workDays++;
    }

    date = date.add(1, 'days');
  }

  return workDays;
}

function getRemainingLunches(transactions) {
  let remainingLunches = 0;
  let date = moment.tz('Asia/Jerusalem');
  const currentMonth = date.month();

  if (!hasRemainingLunchToday(transactions, date)) {
    date = date.add(1, 'days');
  }

  while (date.month() == currentMonth) {
    if (date.day() < 5) { // Fri: 5, Sat: 6
      remainingLunches++;
    }

    date = date.add(1, 'days');
  }

  return remainingLunches;
}

function hasRemainingLunchToday(transactions, date) {
  if (date.hour() >= 17) {
    return false;
  }

  const todayLunchTransaction = transactions
    .find(t => t.date.isSame(date, 'day') && t.date.hour() > 17);
  
  return todayLunchTransaction ? false : true;
}

function getMonthHolidays(year, month) {
  const gregYear = new Hebcal.GregYear(year, month + 1);
  const holidays = 
    Object.values(gregYear.holidays).map(event => {
      return {
        name: event[0].desc[0], 
        date: event[0].date.greg()
      }
    })
    .filter(event => {
      !event.name.includes('Shabbat') && !event.name.includes('Rosh Chodesh')
    });
}

function sumLunchTransactions(transactions) {
  return transactions
    .filter(t => t.date.hour() < 17)
    .map(t => t.amount)
    .reduce((total, amount) => total + amount);
}
