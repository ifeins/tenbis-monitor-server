const axios = require('axios');
const moment = require('moment');
const values = require('object.values');
require('moment-timezone');
require('string.prototype.padstart').shim();

const Hebcal = require('hebcal');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

if (!Object.values) {
  values.shim();
}

const TENBIS_API_URL = 'https://www.10bis.co.il/api'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 5_0 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9A334 Safari/7534.48.3'

const DAILY_LUNCH_BUDGET = 40;
const MAX_LUNCH_LIMIT = 150;

const HOLIDAY_NAMES = [
  "Pesach: 1",
  "Pesach: 2",
  "Pesach: 7",
  "Pesach: 8",
  "Erev Shavuot",
  "Shavuot 1",
  "Yom HaAtzma\\ut",
  "Erev Rosh Hashana",
  "Rosh Hashana 1",
  "Rosh Hashana 2",
  "Erev Yom Kippur",
  "Yom Kippur",
  "Erev Sukkot",
  "Sukkot: 1",
  "Shmini Atzeret",
  "Simchat Torah",
];

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

exports.updateTransactions = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;

  const date = moment.tz('Asia/Jerusalem');
  
  fetchMonthlySummary(userId)
    .then(response => {
      const docRef = getReportDocRef(date);
      docRef.set(response.summary);
    })
    .catch(err => renderError(res, err));
});

exports.getTransactions = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;
  const tenbisUid = req.body.tenbisUid;

  fetchMonthlySummary(userId, tenbisUid)
    .then(response => res.status(200).send(response))
    .catch(err => renderError(res, err));
});

function getReportDocRef(date) {
  const month = date.month() + 1; // moment returns months that start from 0-11
  const year = date.year();
  const docId = `${month.padStart(2, '0')}/${year}}`
  return db.doc(`users/${userId}/reports/${docId}`);
}

function renderError(res, err) {
  console.log(err);
  if (err.status && err.data) {
    res.status(err.status).send(JSON.stringify(err.data.toString()));
  } else {
    res.status(500).send(JSON.stringify(err.toString()));
  }
}

function fetchMonthlySummary(userId, tenbisUid) {
  const service = createService();

  return new Promise((resolve, reject) => {
    fetchTenbisUid(userId, tenbisUid)
      .then(tenbisUid => fetchTransactions(service, tenbisUid))
      .then(transactions => buildResponse(transactions))
      .then(response => resolve(response))
      .catch(err => reject(err));
  });  
}

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
    const monthlyLunchBudget = workDays * DAILY_LUNCH_BUDGET;
    const totalSpent = sumLunchTransactions(transactions);
    const averageLunchSpending = getAverageLunchSpending(totalSpent, transactions);
    const remainingMonthlyLunchBudget = Math.max(0, monthlyLunchBudget - totalSpent);
    const remainingLunches = getRemainingLunches(transactions);
    const remainingAverageLunchSpending = getRemainingAverageLunchSpending(remainingMonthlyLunchBudget, remainingLunches);

    const response = {
      summary: {
        workDays: workDays,
        monthlyLunchBudget: monthlyLunchBudget,
        totalSpent: totalSpent,
        averageLunchSpending: averageLunchSpending,
        remainingMonthlyLunchBudget: remainingMonthlyLunchBudget,
        remainingLunches: remainingLunches,                                
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
  const holidays = getMonthHolidays(year, month);

  // as long as we haven't moved to the next month
  while (date.month() == month) {
    if (isWorkDay(holidays, date)) {
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
  const holidays = getMonthHolidays(date.year(), date.month());

  while (date.month() == currentMonth) {
    if (hasRemainingLunch(transactions, holidays, date)) {
      remainingLunches++;
    }

    date = date.add(1, 'days').hour(0).minute(0).second(0).millisecond(0);
  }

  return remainingLunches;
}

function hasRemainingLunch(transactions, holidays, date) {
  if (date.hour() >= 17 || !isWorkDay(holidays, date)) {
    return false;
  }

  const lunchAtGivenDate = transactions
    .find(t => t.date.isSame(date, 'day') && t.date.hour() < 17);
  
  return lunchAtGivenDate ? false : true;
}

function getAverageLunchSpending(totalSpent, transactions) {
  if (transactions.length === 0) return 0;
  return totalSpent / transactions.length;
}

function getRemainingAverageLunchSpending(remainingMonthlyLunchBudget, remainingLunches) {
  if (remainingLunches <= 0) return 0;

  let average = Math.min(remainingMonthlyLunchBudget / remainingLunches, MAX_LUNCH_LIMIT);
  average = Math.max(average, 0);

  return average;
}

function sumLunchTransactions(transactions) {
  return transactions
    .filter(t => t.date.hour() < 17)
    .map(t => t.amount)
    .reduce((total, amount) => total + amount);
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
    .filter(event => HOLIDAY_NAMES.includes(event.name));

  return holidays;
}

function isWorkDay(holidays, date) {
  // Fri: 5, Sat: 6
  return date.day() < 5 && !isHoliday(holidays, date);
}

function isHoliday(holidays, date) {
  const holiday = holidays.find(holiday => moment(holiday.date).isSame(date, 'day'));
  return holiday ? true : false;
}
