require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const bodyParser = require('body-parser');
const moment = require('moment');
const cors = require('cors');
const fs = require('fs');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const authRoutes = require('./routes/auth');

const protect = require('./middleware/auth');
const isAdmin = require('./middleware/admin');;
const Counter = require('./models/counter'); // Ensure the correct path to the Counter model
const Order = require('./models/order'); // Ensure the correct path to the Order model
const Transaction = require('./models/transaction');
const feedbackRoutes = require('./routes/feedback');



const app = express();
const port = process.env.PORT || 3000;
const hostname = 'localhost';

// Remove duplicate Order model declaration
// const Order = mongoose.model('Order', orderSchema);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }) // Ensure MONGO_URI is set in your .env file
}));

app.use('/api/auth', authRoutes);
app.use('/api', feedbackRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// Middleware to make the session available to templates
app.use((req, res, next) => {
  res.locals.user = req.session.userId ? req.session.userId : null;
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

const consumer_key = process.env.CONSUMER_KEY;
const consumer_secret = process.env.CONSUMER_SECRET;
const shortCode = process.env.SHORT_CODE;
const passkey = process.env.PASSKEY;
const callbackURL = process.env.CALLBACK_URL ||  'https://942f-154-159-237-207.ngrok-free.app//callback';
const validationURL = process.env.VALIDATION_URL || 'https://942f-154-159-237-207.ngrok-free.app//validation';

async function getAccessToken() {
  const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  const auth = 'Basic ' + Buffer.from(consumer_key + ':' + consumer_secret).toString('base64');

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: auth,
      },
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error.response ? error.response.data : error.message);
    throw error;
  }
}

app.post('/stkpush', async (req, res) => {
  const { phoneNumber, amount } = req.body;

  if (!phoneNumber || !amount) {
    return res.status(400).send({ message: 'Phone number and amount are required' });
  }

  const amountInKES = parseInt(amount, 10);
  if (isNaN(amountInKES) || amountInKES <= 0) {
    return res.status(400).send({ message: 'Invalid amount' });
  }

  try {
    const accessToken = await getAccessToken();
    const url = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
    const auth = 'Bearer ' + accessToken;
    const timestamp = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(shortCode + passkey + timestamp).toString('base64');

    const response = await axios.post(url, {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: shortCode,
      PhoneNumber: phoneNumber,
      CallBackURL: callbackURL,
      AccountReference: 'Writers cash',
      TransactionDesc: 'Payment for goods',
    }, {
      headers: {
        Authorization: auth,
      },
    });

    console.log('STK Push request successful:', response.data);
    res.status(200).send({ message: 'Request successful' });
  } catch (error) {
    console.error('Error in /stkpush route:', error.response ? error.response.data : error.message);
    res.status(500).send({ message: 'Request failed' });
  }
});
app.post('/callback', async (req, res) => {
  console.log('Received STK PUSH CALLBACK:', JSON.stringify(req.body, null, 2));

  const callbackData = req.body.Body.stkCallback;
  if (!callbackData) {
    console.error('Invalid callback data:', req.body);
    return res.status(400).send('Invalid callback data');
  }

  const CheckoutRequestID = callbackData.CheckoutRequestID;
  const ResultCode = callbackData.ResultCode;
  const ResultDesc = callbackData.ResultDesc;
  const Amount = callbackData.CallbackMetadata.Item.find(item => item.Name === 'Amount').Value;
  const MpesaReceiptNumber = callbackData.CallbackMetadata.Item.find(item => item.Name === 'MpesaReceiptNumber').Value;
  const Balance = callbackData.CallbackMetadata.Item.find(item => item.Name === 'Balance') ? callbackData.CallbackMetadata.Item.find(item => item.Name === 'Balance').Value : null;
  const TransactionDate = callbackData.CallbackMetadata.Item.find(item => item.Name === 'TransactionDate').Value;
  const PhoneNumber = callbackData.CallbackMetadata.Item.find(item => item.Name === 'PhoneNumber').Value;

  console.log('Parsed Callback Data:');
  console.log('CheckoutRequestID:', CheckoutRequestID);
  console.log('ResultCode:', ResultCode);
  console.log('ResultDesc:', ResultDesc);
  console.log('Amount:', Amount);
  console.log('MpesaReceiptNumber:', MpesaReceiptNumber);
  console.log('Balance:', Balance);
  console.log('TransactionDate:', TransactionDate);
  console.log('PhoneNumber:', PhoneNumber);

  const transaction = new Transaction({
    CheckoutRequestID,
    ResultCode,
    ResultDesc,
    Amount,
    MpesaReceiptNumber,
    Balance,
    TransactionDate,
    PhoneNumber
  });

  try {
    const savedTransaction = await transaction.save();
    console.log('Transaction saved:', savedTransaction);

    // Update the order status to 'Paid'
    const order = await Order.findOne({ orderId: CheckoutRequestID });
    if (order) {
      order.paymentStatus = 'Paid';
      await order.save();
      console.log('Order payment status updated:', order);
    } else {
      console.error('Order not found for CheckoutRequestID:', CheckoutRequestID);
    }

    res.status(200).send('Callback received');
  } catch (err) {
    console.error('Error saving transaction or updating order:', err);
    res.status(500).send('Error saving transaction or updating order');
  }
});



app.get('/registerurl', async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const url = 'https://sandbox.safaricom.co.ke/mpesa/c2b/v1/registerurl';
    const auth = 'Bearer ' + accessToken;

    const response = await axios.post(url, {
      ShortCode: shortCode,
      ResponseType: 'Completed',
      ConfirmationURL: callbackURL,
      ValidationURL: validationURL,
    }, {
      headers: {
        Authorization: auth,
      },
    });

    console.log('Callback URL registered:', response.data);
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error in /registerurl route:', error.response ? error.response.data : error.message);
    res.status(500).send('❌ Request failed');
  }
});

app.get('/query/:CheckoutRequestID', async (req, res) => {
  const { CheckoutRequestID } = req.params;

  try {
    const accessToken = await getAccessToken();
    const url = 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query';
    const auth = 'Bearer ' + accessToken;
    const timestamp = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(shortCode + passkey + timestamp).toString('base64');

    const response = await axios.post(url, {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID,
    }, {
      headers: {
        Authorization: auth,
      },
    });

    console.log('Query response:', response.data);
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error in /query route:', error.response ? error.response.data : error.message);
    res.status(500).send('❌ Request failed');
  }
});

// Additional Routes
app.get('/', (req, res) => res.render('index'));
app.get('/order', protect, (req, res) => res.render('order'));
app.get('/pricing', (req, res) => res.render('pricing'));
app.get('/review', protect, (req, res) => res.render('review'));
app.get('/sample', (req, res) => res.render('sample'));
app.get('/login', (req, res) => res.render('login'));
app.get('/order-summary', (req, res) => {res.render('order-summary');});

app.get('/customer', protect, async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  try {
    const orders = await Order.find({ userId: req.session.userId });
    res.render('customer', { user: req.session.user, orders });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const transactions = await Transaction.find({});
    const orders = await Order.find({});
    res.render('dashboard', { transactions, orders });
  } catch (err) {
    console.error('Error fetching transactions or orders:', err);
    res.status(500).send('Error fetching transactions or orders');
  }
});





app.get('/paypal-client-id', (req, res) => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  res.json({ clientId });
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');

    // Initialize the counter if it does not exist
    const counter = await Counter.findOne({ name: 'orderId' });
    if (!counter) {
      const newCounter = new Counter({ name: 'orderId', seq: 100000 });
      await newCounter.save();
    }
  })
  .catch((err) => console.log(err));
 // Multer storage setup
 const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
      cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });



app.post('/order', protect, async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('Unauthorized');
  }

  try {
    // Get the next order ID from the counter
    const counter = await Counter.findOneAndUpdate(
      { name: 'orderId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const orderId = counter.seq;

    // Check if an order with the same orderId already exists
    const existingOrder = await Order.findOne({ orderId: orderId });
    if (existingOrder) {
      return res.status(400).send('Order with this ID already exists.');
    }

    const orderData = {
      orderId: orderId,
      userId: req.session.userId,
      ...req.body,
      CheckoutRequestID: req.body.CheckoutRequestID || null,
      transactionDetails: req.body.transactionDetails || null,
    };

    const newOrder = new Order(orderData);

    await newOrder.save();

    if (req.body.paypalDetails) {
      const paypalTransaction = new Transaction({
        Amount: req.body.paypalDetails.purchase_units[0].amount.value,
        TransactionDate: new Date(req.body.paypalDetails.create_time),
        paypalDetails: req.body.paypalDetails
      });
      await paypalTransaction.save();
    }

    res.json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(400).send('Error: ' + err);
  }
});



// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://${hostname}:${port}`);
});


/*




app.post('/order', protect, async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('Unauthorized');
  }

  try {
    // Get the next order ID from the counter
    const counter = await Counter.findOneAndUpdate(
      { name: 'orderId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const orderId = counter.seq;

    // Check if an order with the same orderId already exists
    const existingOrder = await Order.findOne({ orderId: orderId });
    if (existingOrder) {
      return res.status(400).send('Order with this ID already exists.');
    }

    const orderData = {
      orderId: orderId,
      userId: req.session.userId,
      ...req.body,
      CheckoutRequestID: req.body.CheckoutRequestID || null,
      transactionDetails: req.body.transactionDetails || null,
    };

    const newOrder = new Order(orderData);

    await newOrder.save();

    if (req.body.paypalDetails) {
      const paypalTransaction = new Transaction({
        Amount: req.body.paypalDetails.purchase_units[0].amount.value,
        TransactionDate: new Date(req.body.paypalDetails.create_time),
        paypalDetails: req.body.paypalDetails
      });
      await paypalTransaction.save();
    }

    res.json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(400).send('Error: ' + err);
  }
});



mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');

    // Initialize the counter if it does not exist
    const counter = await Counter.findOne({ name: 'orderId' });
    if (!counter) {
      const newCounter = new Counter({ name: 'orderId', seq: 100000 });
      await newCounter.save();
    }
  })
  .catch((err) => console.log(err));

const paypal = require('./paypalConfig'); // Import your PayPal config
const bodyParser = require('body-parser');
require('dotenv').config();
app.post('/pay', async (req, res) => {
    try {
        // Call a function to generate PayPal order and get approval URL
        const url = await paypal.createOrder(); // Adjust this as per your actual implementation

        // Assuming paypal.createOrder() returns the approval URL
        res.status(200).send(url); // Send approval URL to client
    } catch (error) {
        console.error('Error creating PayPal order:', error);
        res.status(500).send('Failed to initiate payment'); // Handle error response
    }
});

app.get('/complete-order', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) {
            throw new Error('Missing token parameter');
        }

        // Assuming your PayPal configuration includes a function to capture the payment
        await paypal.capturePayment(token);

        res.send('Course purchased successfully');
    } catch (error) {
        res.status(500).send('Error completing order: ' + error.message);
    }
});

// Route for canceling the order
app.get('/cancel-order', (req, res) => {
    res.redirect('/');
}); */