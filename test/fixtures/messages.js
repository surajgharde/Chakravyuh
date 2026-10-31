/**
 * The Guardian accuracy corpus: 20 scam messages and 20 legitimate ones.
 *
 * Kept in its own module so the test suite and any offline tooling score the
 * exact same messages. Each entry is [name, text].
 *
 * The legitimate half is deliberately hard: a real bank OTP SMS, a utility
 * reminder that mentions disconnection, a courier update with a link, and
 * family messages in Marathi and Hindi. Those are the messages a naive
 * keyword matcher gets wrong.
 */

const SCAM = [
    ['digital arrest, CBI', 'Madam, this is CBI headquarters. A parcel in your name contained MDMA. Do not tell anyone and do not disconnect the call.'],
    ['digital arrest, payment', 'A non-bailable warrant is ready. Transfer Rs 2,50,000 to the RBI verification account 50100234567890 immediately.'],
    ['customs parcel', 'Your FedEx parcel has been seized by customs today. Pay the clearance fee of 18500 to account 50100234567890 right now or you will be arrested.'],
    ['KYC OTP', 'Sir your SBI account will be blocked today. Share the OTP sent to your phone immediately.'],
    ['card block OTP', 'Your debit card is blocked. Confirm the CVV and the OTP now to reactivate it.'],
    ['UPI collect', 'To receive your refund, approve the request and send 5000 on PhonePe to refund@okaxis immediately.'],
    ['electricity disconnect scam', 'Your electricity connection will be disconnected tonight. Pay 4500 to UPI mseb.bill@ybl right now.'],
    ['tech support apk', 'Your computer has a virus. Install AnyDesk from http://quick-support.site/helper.apk so our technician can fix it.'],
    ['remote access', 'Download the bank secure app and share your screen with me so I can complete the verification.'],
    ['lottery advance fee', 'Congratulations, you have won Rs 25 lakh in the KBC draw. Pay the processing fee to account 50100234567890 to claim it today.'],
    ['job scam', 'Work from home job, daily 2000 rupees. Pay the registration fee of 1500 to 8899776655@ybl immediately to confirm your seat.'],
    ['investment crypto', 'Guaranteed 300 percent returns. Transfer your USDT to wallet TQ5NMqJjKPjGGLLFMkqTz6kaFiLBf5H2rN today itself.'],
    ['TRAI SIM threat', 'This is TRAI. Your Aadhaar has been misused for 17 SIM cards. Your number will be disconnected within 2 hours unless you verify now.'],
    ['phishing link', 'Your KYC has expired. Click hxxp://sbi-kyc[.]in/update and login immediately or the account is suspended today.'],
    ['safe account lure', 'For your safety, transfer the entire balance to this RBI safe account 50100234567890. It is fully refundable after verification.'],
    ['police hinglish', 'Mi Pune police station madhun bolat aahe. Tumchya khatyat hawala che paise aale aahet. Lagech 1 lakh transfer kara, konala sangu naka.'],
    ['Marathi penalty', 'मी सायबर विभागातून बोलत आहे. दंडाची रक्कम ताबडतोब खात्यात 50100234567890 जमा करा. कोणालाही सांगू नका.'],
    ['Hindi OTP', 'मैं एचडीएफसी बैंक से बोल रहा हूं। आपका खाता आज ब्लॉक हो जाएगा। तुरंत ओटीपी बताओ।'],
    ['courier redelivery', 'Your parcel delivery failed. Pay the redelivery charge of 50 rupees on this UPI id courier.pay@paytm within 1 hour or it returns.'],
    ['video call arrest', 'Stay on this video call with the officer until the verification is complete. Do not inform your family about this case.'],
];

const LEGIT = [
    ['son about dinner', 'Maa, what is for dinner today? I will reach home by 8.'],
    ['daughter calling later', 'Mummy I am in a meeting, I will call you back in an hour.'],
    ['doctor appointment', 'Reminder: your appointment with Dr. Kulkarni is tomorrow at 10:30 am at Sahyadri Clinic.'],
    ['clinic reschedule', 'Your blood test report is ready for collection. The clinic is open till 7 pm.'],
    ['real bank OTP SMS', 'Your OTP for a transaction of Rs 5,000 is 884512. Do not share it with anyone. -SBI'],
    ['real bank advisory', 'Dear customer, your bank will never ask for your OTP, PIN or CVV. Report any such call to the number printed on your card.'],
    ['bank credit alert', 'Rs 25,000 has been credited to your account XXXX4521 on 30-Oct. No action is required.'],
    ['courier out for delivery', 'Your Bluedart shipment AWB 12345678 is out for delivery today. Track at bluedart.com'],
    ['courier delivered', 'Your parcel has been delivered and signed for. Thank you for shopping with us.'],
    ['delivery agent at gate', 'Sir, I am at the gate with your Amazon package. Please come down to collect it.'],
    ['electricity bill reminder', 'Your electricity bill of Rs 1,240 is due on 5 November. Pay at mahadiscom.in. Ignore this if already paid.'],
    ['gas booking', 'Your LPG cylinder booking is confirmed. Delivery is expected on 2 November between 10 am and 4 pm.'],
    ['wrong number', 'Hello? Is this Ramesh tailor shop? Sorry, wrong number.'],
    ['pharmacy pickup', 'Your prescription is ready for pickup at Apollo Pharmacy till 8 pm today.'],
    ['Marathi appointment', 'नमस्कार, तुमची अपॉइंटमेंट उद्या सकाळी दहा वाजता आहे. कृपया वेळेवर यावे.'],
    ['Marathi family', 'आई, मी संध्याकाळी घरी येतो. जेवायला थांबू नकोस.'],
    ['Hindi family', 'माँ, मैं कल सुबह की ट्रेन से आ रहा हूं। चिंता मत करो।'],
    ['temple event', 'Ganpati aarti is at 7 pm in the society hall. All members are requested to attend.'],
    ['insurance premium notice', 'Your LIC policy premium of Rs 12,000 is due on 15 November. Visit your nearest branch for assistance.'],
    ['school fee receipt', 'Fee receipt for the second term has been issued. Collect it from the school office during working hours.'],
];

module.exports = { SCAM, LEGIT };
