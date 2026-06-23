const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const mongodb = require('mongodb');
const { type } = require('node:os');

require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//MongoDB connection
const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI)
.then(()=> console.log("MongoDB connected successfully"))
.catch((err)=> console.error("MongoDB connection error:", err));

const orderSchema = new mongoose.Schema({
    customer: {
        firstName: String,
        lastName: String,
        email: String,
        phone: String,
        address: String,
        city: String,
        state: String,
        pincode: String,
    },
    items:[
        {
            id: String,
            title: String,
            weight: String,
            quantity: Number,
            price: String,
            image: String
        }
    ],
    totalAmount: Number,
    paymentMethod: String,
    paymentStatus: {type: String, default: "Pending"},
    deliveryStatus:{type:String, default:"Pending"},
    razorpayPaymentID: {type: String, default: null},
    razorpayOrderID: {type: String, default: null},
    dataCreated: {type: Date, default: Date.now}
});

const Order = mongoose.model('Order', orderSchema);

app.get('/', (req, res) => {
    res.send('server is running');
});

app.post('/api/orders/save', async (req, res) => {
    try{
        console.log("Saving order to database:", req.body);
        const {customer, items, totalAmount, paymentMethod, razorpayPaymentID, razorpayOrderID} = req.body;
        
        const newOrder = new Order({
            customer,
            items,
            totalAmount,
            paymentMethod,
            razorpayPaymentID,
            razorpayOrderID
        });

        const savedOrder = await newOrder.save();
        res.status(201).json({success: true, data: savedOrder});
        
    }catch(error){
        console.error("Error saving order:", error);
        res.status(500).json({success: false, error: "Failed to save order"});

    }
});

app.get('/', (req, res) => {
    res.send('server is running');
});

// 1. Route to create a Razorpay Order
app.post('/order', async (req, res) => {
    try {
        // console.log("KEY_ID =", process.env.RAZORPAY_KEY_ID);
        // console.log("KEY_SECRET =", process.env.RAZORPAY_KEY_SECRET);
        // console.log("buynow request", req.body);

            console.log("Incoming request body:", req.body);
         const { amount, currency, receipt } = req.body;

         if (!amount){
            return res.status(400).json({ error: "Amount is required" });       
         }

         const flatFeePaise=0;
         const finalAmountPaise = Number(amount) + flatFeePaise;

        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        });

        

        const options = {
            amount:finalAmountPaise, // Amount in paise
            currency: "INR",
            receipt:`receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        
        if (!order) {
            return res.status(500).send("Some error occurred while creating the order");
        }

        res.json(order);
    } catch (error) {
        console.error("Error creating order:", error);
        res.status(500).json({ error: error.message });
    }
});

//Added: secure route to get all orders for your admin dashboard
app.get('/api/admin/orders', async(req,res) => {
    try{
        const orders = await Order.find({}).sort({dataCreated:-1});
        res.json({success:true, data:orders});
    }catch(error){
        console.error("Error fetching admin orders:", error);
        res.status(500).json({success:false, message:"Internal server Error loading admin order", error:error.message});
    }
});

// Add this route to your backend index.js file
// Replace your update-payment route in backend index.js with this:
app.post("/api/admin/orders/update-payment", async (req, res) => {
    try {
        const { orderId, paymentStatus } = req.body;
        
        // CRITICAL FIX: Use $set so MongoDB ONLY modifies paymentStatus
        // and leaves the items array untouched!
        const updatedOrder = await Order.findByIdAndUpdate(
            orderId, 
            { $set: { paymentStatus: paymentStatus } }, 
            { new: true }
        );

        if (!updatedOrder) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        res.json({ success: true, message: "Payment status updated!", data: updatedOrder });
    } catch (error) {
        console.error("Error updating payment status:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

app.post("/api/admin/orders/update-delivery", async(req,res)=>{
    try{
        const {orderId , deliveryStatus}= req.body;
        
        if(!orderId){
            return res.status(400).json({success : false , message: "Missing orderId"});
        }

        const cleanId = orderId.trim();

        const updatedOrder = await Order.findByIdAndUpdate(
            cleanId,
            {$set: {deliveryStatus: deliveryStatus}},
            {new:true}
        );

        if (!updatedOrder){
            return res.status(404).json({success :false , message: "Order Not Found"});
        }

        res.json({success:true , message:"Delivery status updated successfully",data: updatedOrder});
    }catch(error){
        console.error("Error updating delivery status:", error);
        res.status(500).json({success: false , message: "Internal server error"});
    }
});

app.delete('/api/admin/orders/:id', async (req,res)=>{
    try{
        const orderID = req.params.id;

        if(!orderID){
            return res.status(400).json({success: false , message:"Missing orderId parameter"});
        }

        const cleanId = orderID.trim();

        const deletedOrder = await Order.findByIdAndDelete(cleanId);

       

        if(!deletedOrder){
            return res.status(404).json({success : false , message: "Order not found"});
        }
        res.json({success: true, message:"Order deleted successfully from database!"});
    }catch(error){
        console.error("Error deleting order:", error);
        res.status(500).json({success: false , message :"Internal server error"});
    }
});

// 2. Route to verify Razorpay Payment Signature
app.post('/verify', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer,items,totalAmount } = req.body;

        // Generate the expected signature using your Secret Key
        const sha = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
        sha.update(`${razorpay_order_id}|${razorpay_payment_id}`);
        const expectedSignature = sha.digest("hex");

        // Authenticate the payment signature
        if (expectedSignature === razorpay_signature) {
            console.log("Payment verification successful!");

            const newOrder = new Order({
                customer,
                items,
                totalAmount,
                paymentMethod:"Online payment",
                paymentStatus:"Paid",
                razorpayPaymentID:razorpay_payment_id,
                razorpayOrderID: razorpay_order_id
            });

            const saveOrder = await newOrder.save();

            return res.json({ status: "success", message: "Payment verified successfully", data:saveOrder });
        } else {
            console.log("Payment verification failed!");
            return res.status(400).json({ status: "failure", message: "Invalid signature match" });
        }
    } catch (error) {
        console.error("Error verifying payment:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
