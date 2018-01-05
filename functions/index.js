const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

exports.updateUser = functions.https.onRequest((req, res) => {
  const userId = req.body.userId;  
  const phone = req.body.phone;

  const docRef = db.collection('users').document(userId);
  docRef.set({phone: phone});

  res.sendStatus(200);
});
