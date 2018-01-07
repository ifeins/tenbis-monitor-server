const axios = require('axios');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

const TENBIS_API_URL = 'https://www.10bis.co.il/api'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 5_0 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9A334 Safari/7534.48.3'

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

  const instance = axios.create({
    baseURL: TENBIS_API_URL,
    headers: {'User-Agent': USER_AGENT}
  });

  instance.get('/login')
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
  