# Firebase Setup Instructions

Your journal app is now ready for cloud sync! Follow these steps to complete the setup.

## Step 1: Deploy Firestore Security Rules

The rules live in `firestore.rules` (owner-only access plus validation of each entry's fields). Deploy them together with hosting:

```bash
firebase login --reauth
firebase deploy --only firestore:rules,hosting
```

To check that the rules compile without changing anything, run `firebase deploy --only firestore:rules --dry-run`.

Hosting security headers (Content-Security-Policy, HSTS, etc.) are set in `firebase.json`. If you add a new external script or service, add its domain to the CSP there.

## Step 2: Test Your App

1. Open `index.html` in your web browser
2. You'll see the new **Sign In / Create Account** page

### Create Your Account
1. Click **"Create one"** (or the link to create an account)
2. Enter your email and a password (minimum 8 characters)
3. Click **"Create Account"**
4. You should be automatically logged in

### If You Had Previous Entries
- If you had entries in the old version, you'll see a migration popup
- Click **"Import to Cloud"** to transfer them to your new cloud account
- All your old entries will be imported automatically

## Step 3: Test Cloud Sync

### Test on Same Device
1. Create a new journal entry
2. Open the app in another browser or incognito window
3. Sign in with the same email/password
4. Your entry should appear automatically!

### Test on Multiple Devices
1. Open the app on your phone or another computer
2. Sign in with your email/password
3. You'll see all your entries synced!
4. Create an entry on one device
5. Watch it appear instantly on the other device

## Features You Now Have

✅ **Email/Password Authentication** - Secure login system
✅ **Cloud Storage** - Entries saved to Firebase Firestore
✅ **Multi-Device Access** - Access from anywhere
✅ **Real-Time Sync** - Changes appear instantly on all devices
✅ **Offline Support** - Works without internet, syncs when back online
✅ **Automatic Backup** - Your data is safely stored in the cloud
✅ **Password Reset** - Click "Forgot password?" to reset via email

## Important Notes

### Your Data is Secure
- All data encrypted in transit (HTTPS)
- Only you can access your entries (Firebase security rules)
- Password stored securely by Firebase (hashed and salted)

### Storage Limits
- Firebase Free Tier gives you:
  - 1 GB storage
  - 50,000 reads/day
  - 20,000 writes/day
- This is MORE than enough for personal journal use

### Cost
- **$0/month** for personal use
- The free tier is very generous

## Troubleshooting

### "Permission denied" errors
- Make sure you published the security rules above
- Make sure you're signed in

### Entries not syncing
- Check your internet connection
- Try refreshing the page
- Sign out and sign back in

### Forgot Password
1. Click "Forgot password?" on the sign-in page
2. Enter your email
3. Check your inbox for a password reset email
4. Follow the link to create a new password

### Can't create account
- Make sure password is at least 8 characters
- Email must be valid format
- Email can't already be registered

## Need Help?

If you encounter any issues:
1. Open browser developer console (F12)
2. Look for error messages in the Console tab
3. Check the Network tab for failed requests

## Next Steps (Optional)

### Enable Firebase Hosting
If you want to access your journal from a public URL instead of opening the HTML file:

1. Install Firebase CLI: `npm install -g firebase-tools`
2. Login: `firebase login`
3. Initialize hosting: `firebase init hosting`
4. Deploy: `firebase deploy --only hosting`
5. You'll get a URL like: `https://adjournal.web.app`

---

**Congratulations! Your journal now has secure cloud sync! 🎉**
