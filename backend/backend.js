require('dotenv').config();
const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const { Resend } = require('resend');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'avtorent_secret_key_2026';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'AvtoRent <onboarding@resend.dev>';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Ensure storage folders exist
const dataDir = path.join(__dirname, '..', 'data');
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ==========================================
// DATABASE SETUP (SQLite)
// ==========================================
const dbPath = path.join(dataDir, 'avtorent.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode and foreign keys
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  surname TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  email_verified INTEGER DEFAULT 0,
  role TEXT DEFAULT 'user',
  google_id TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  color TEXT NOT NULL,
  body_type TEXT NOT NULL,
  transmission TEXT NOT NULL,
  fuel_type TEXT NOT NULL,
  seats INTEGER DEFAULT 5,
  mileage INTEGER DEFAULT 0,
  region TEXT NOT NULL,
  city TEXT NOT NULL,
  district TEXT DEFAULT '',
  pickup_address TEXT DEFAULT '',
  daily_price INTEGER NOT NULL,
  deposit INTEGER DEFAULT 0,
  min_rental_days INTEGER DEFAULT 1,
  min_age INTEGER DEFAULT 21,
  min_experience INTEGER DEFAULT 1,
  daily_km_limit INTEGER DEFAULT 300,
  smoking_allowed INTEGER DEFAULT 0,
  pets_allowed INTEGER DEFAULT 0,
  abroad_allowed INTEGER DEFAULT 0,
  extra_rules TEXT DEFAULT '',
  status TEXT DEFAULT 'ACTIVE',
  rating REAL DEFAULT 5.0,
  review_count INTEGER DEFAULT 1,
  main_image TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS car_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL,
  image_url TEXT NOT NULL,
  tag TEXT DEFAULT 'other',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL,
  renter_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  total_days INTEGER NOT NULL,
  daily_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  status TEXT DEFAULT 'PENDING',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE,
  FOREIGN KEY(renter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  car_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, car_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL,
  renter_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(car_id, renter_id, owner_id),
  FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE,
  FOREIGN KEY(renter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT DEFAULT '',
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT DEFAULT NULL;');
} catch (e) {}

// ==========================================
// SEED INITIAL DATA (DEMO CARS & TEST OWNER)
// ==========================================
function seedInitialData() {
  const usersCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  let ownerId = 1;
  if (usersCount === 0) {
    const defaultPassword = bcrypt.hashSync('avto123456', 10);
    const insertUser = db.prepare(`
      INSERT INTO users (name, surname, email, password_hash, phone, avatar_url, email_verified, role)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'admin')
    `);
    const result = insertUser.run(
      'Sayfulloh',
      'Sharipov',
      'siusbknczd@gmail.com',
      defaultPassword,
      '+998 90 123 45 67',
      'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80'
    );
    ownerId = Number(result.lastInsertRowid);
    console.log('✅ Demo egasi (admin) yaratildi: siusbknczd@gmail.com (parol: avto123456)');
  } else {
    const firstUser = db.prepare('SELECT id FROM users LIMIT 1').get();
    ownerId = firstUser.id;
  }

  const carsCount = db.prepare('SELECT COUNT(*) as count FROM cars').get().count;
  if (carsCount === 0) {
    const demoCars = [
      {
        brand: 'Chevrolet',
        model: 'Cobalt',
        year: 2023,
        color: 'Oq (Snow White)',
        body_type: 'Sedan',
        transmission: 'Avtomat',
        fuel_type: 'Benzin',
        seats: 5,
        mileage: 38000,
        region: 'Toshkent',
        city: 'Toshkent shahri',
        district: 'Yunusobod tumani',
        pickup_address: 'Mega Planet savdo markazi yaqinida',
        daily_price: 350000,
        deposit: 1000000,
        min_rental_days: 1,
        min_age: 21,
        min_experience: 1,
        daily_km_limit: 300,
        smoking_allowed: 0,
        pets_allowed: 0,
        abroad_allowed: 0,
        extra_rules: 'Toza holda topshiriladi, toza holda qaytariladi. Jarimalar haydovchi hisobidan.',
        status: 'ACTIVE',
        rating: 4.9,
        review_count: 14,
        main_image: 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=800&q=80',
        images: [
          'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1583121274602-3e2820c69888?auto=format&fit=crop&w=800&q=80'
        ]
      },
      {
        brand: 'Chevrolet',
        model: 'Gentra (Lacetti)',
        year: 2022,
        color: 'Qora (Carbon Flash)',
        body_type: 'Sedan',
        transmission: 'Avtomat',
        fuel_type: 'Benzin',
        seats: 5,
        mileage: 52000,
        region: 'Toshkent',
        city: 'Toshkent shahri',
        district: 'Mirzo Ulug‘bek tumani',
        pickup_address: 'Buyuk Ipak Yo‘li metro',
        daily_price: 380000,
        deposit: 1200000,
        min_rental_days: 2,
        min_age: 22,
        min_experience: 2,
        daily_km_limit: 250,
        smoking_allowed: 0,
        pets_allowed: 0,
        abroad_allowed: 0,
        extra_rules: 'Konditsioner a‘lo holatda. Magicar 905 pult mavjud.',
        status: 'ACTIVE',
        rating: 4.8,
        review_count: 9,
        main_image: 'https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=800&q=80',
        images: [
          'https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80'
        ]
      },
      {
        brand: 'Chevrolet',
        model: 'Malibu 2 Turbo',
        year: 2023,
        color: 'Qora (Black Pearl)',
        body_type: 'Sedan',
        transmission: 'Avtomat',
        fuel_type: 'Benzin',
        seats: 5,
        mileage: 26000,
        region: 'Toshkent',
        city: 'Toshkent shahri',
        district: 'Chilonzor tumani',
        pickup_address: 'Novza metro yaqinida',
        daily_price: 850000,
        deposit: 2500000,
        min_rental_days: 1,
        min_age: 24,
        min_experience: 3,
        daily_km_limit: 300,
        smoking_allowed: 0,
        pets_allowed: 0,
        abroad_allowed: 0,
        extra_rules: 'Premium biznes sinfidagi avtomobil. Faqat 95/98 benzin quyiladi.',
        status: 'ACTIVE',
        rating: 5.0,
        review_count: 21,
        main_image: 'https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&w=800&q=80',
        images: [
          'https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80'
        ]
      },
      {
        brand: 'Kia',
        model: 'K5 GT-Line',
        year: 2023,
        color: 'To‘q kulrang (Steel Gray)',
        body_type: 'Sedan',
        transmission: 'Avtomat',
        fuel_type: 'Benzin',
        seats: 5,
        mileage: 31000,
        region: 'Samarqand',
        city: 'Samarqand shahri',
        district: 'Markaz',
        pickup_address: 'Registon maydoni atrofida',
        daily_price: 900000,
        deposit: 2500000,
        min_rental_days: 1,
        min_age: 23,
        min_experience: 2,
        daily_km_limit: 350,
        smoking_allowed: 0,
        pets_allowed: 0,
        abroad_allowed: 0,
        extra_rules: 'Panorama tom, zamonaviy multimedia, CarPlay mavjud.',
        status: 'ACTIVE',
        rating: 4.9,
        review_count: 17,
        main_image: 'https://images.unsplash.com/photo-1619767886558-efdc259cde1a?auto=format&fit=crop&w=800&q=80',
        images: [
          'https://images.unsplash.com/photo-1619767886558-efdc259cde1a?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1583121274602-3e2820c69888?auto=format&fit=crop&w=800&q=80'
        ]
      },
      {
        brand: 'Toyota',
        model: 'Camry 75',
        year: 2022,
        color: 'Oq dur (White Pearl)',
        body_type: 'Sedan',
        transmission: 'Avtomat',
        fuel_type: 'Gibrid',
        seats: 5,
        mileage: 44000,
        region: 'Toshkent',
        city: 'Toshkent shahri',
        district: 'Yakkasaroy tumani',
        pickup_address: 'Aeroport hududida yoki markazda yetkazib berish mumkin',
        daily_price: 1100000,
        deposit: 3000000,
        min_rental_days: 2,
        min_age: 25,
        min_experience: 3,
        daily_km_limit: 400,
        smoking_allowed: 0,
        pets_allowed: 0,
        abroad_allowed: 0,
        extra_rules: 'Gibrid tizim, yoqilg‘i sarfi juda tejamkor (5L/100km).',
        status: 'ACTIVE',
        rating: 5.0,
        review_count: 28,
        main_image: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=800&q=80',
        images: [
          'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=800&q=80'
        ]
      },
      {
        brand: 'Hyundai',
        model: 'Elantra',
        year: 2023,
        color: 'Kulrang (Cyber Gray)',
        body_type: 'Sedan',
        transmission: 'Avtomat',
        fuel_type: 'Benzin',
        seats: 5,
        mileage: 28000,
        region: 'Buxoro',
        city: 'Buxoro shahri',
        district: 'Markaz',
        pickup_address: 'Temir yo‘l vokzali yaqini',
        daily_price: 650000,
        deposit: 1500000,
        min_rental_days: 1,
        min_age: 21,
        min_experience: 2,
        daily_km_limit: 300,
        smoking_allowed: 0,
        pets_allowed: 0,
        abroad_allowed: 0,
        extra_rules: 'Toza va yangi avtomobil. Sayyohlar va mehmonlar uchun qulay.',
        status: 'ACTIVE',
        rating: 4.8,
        review_count: 8,
        main_image: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
        images: [
          'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80'
        ]
      }
    ];

    const insertCar = db.prepare(`
      INSERT INTO cars (
        owner_id, brand, model, year, color, body_type, transmission, fuel_type,
        seats, mileage, region, city, district, pickup_address, daily_price,
        deposit, min_rental_days, min_age, min_experience, daily_km_limit,
        smoking_allowed, pets_allowed, abroad_allowed, extra_rules, status,
        rating, review_count, main_image
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertImage = db.prepare(`
      INSERT INTO car_images (car_id, image_url, tag) VALUES (?, ?, ?)
    `);

    for (const c of demoCars) {
      const res = insertCar.run(
        ownerId, c.brand, c.model, c.year, c.color, c.body_type, c.transmission, c.fuel_type,
        c.seats, c.mileage, c.region, c.city, c.district, c.pickup_address, c.daily_price,
        c.deposit, c.min_rental_days, c.min_age, c.min_experience, c.daily_km_limit,
        c.smoking_allowed, c.pets_allowed, c.abroad_allowed, c.extra_rules, c.status,
        c.rating, c.review_count, c.main_image
      );
      const carId = Number(res.lastInsertRowid);
      for (let i = 0; i < c.images.length; i++) {
        insertImage.run(carId, c.images[i], i === 0 ? 'main' : 'gallery');
      }
    }
    console.log(`✅ ${demoCars.length} ta demo avtomobil bazaga kiritildi.`);
  }

  // Update existing cars with HD Pinterest images if they use placeholder/Unsplash images
  try {
    const pinterestCarMap = {
      'Cobalt': [PINTEREST_CAR_IMAGES[0], PINTEREST_CAR_IMAGES[1], PINTEREST_CAR_IMAGES[2], PINTEREST_CAR_IMAGES[3]],
      'Gentra': [PINTEREST_CAR_IMAGES[4], PINTEREST_CAR_IMAGES[5], PINTEREST_CAR_IMAGES[6], PINTEREST_CAR_IMAGES[7]],
      'Malibu': [PINTEREST_CAR_IMAGES[8], PINTEREST_CAR_IMAGES[9], PINTEREST_CAR_IMAGES[10], PINTEREST_CAR_IMAGES[11]],
      'K5': [PINTEREST_CAR_IMAGES[12], PINTEREST_CAR_IMAGES[13], PINTEREST_CAR_IMAGES[14], PINTEREST_CAR_IMAGES[15]],
      'Camry': [PINTEREST_CAR_IMAGES[16], PINTEREST_CAR_IMAGES[17], PINTEREST_CAR_IMAGES[18], PINTEREST_CAR_IMAGES[19]],
      'Elantra': [PINTEREST_CAR_IMAGES[20], PINTEREST_CAR_IMAGES[21], PINTEREST_CAR_IMAGES[22], PINTEREST_CAR_IMAGES[23]],
      'Sonet': [PINTEREST_CAR_IMAGES[24], PINTEREST_CAR_IMAGES[25], PINTEREST_CAR_IMAGES[26], PINTEREST_CAR_IMAGES[27]]
    };

    const allCars = db.prepare('SELECT id, model FROM cars').all();
    for (const car of allCars) {
      for (const [key, imgs] of Object.entries(pinterestCarMap)) {
        if (car.model.includes(key)) {
          db.prepare('UPDATE cars SET main_image = ? WHERE id = ?').run(imgs[0], car.id);
          db.prepare('DELETE FROM car_images WHERE car_id = ?').run(car.id);
          const ins = db.prepare('INSERT INTO car_images (car_id, image_url, tag) VALUES (?, ?, ?)');
          imgs.forEach((img, idx) => ins.run(car.id, img, idx === 0 ? 'main' : 'gallery'));
          break;
        }
      }
    }
    console.log('✅ Avtomobillar rasmlari Pinterest HD rasmlari bilan muvaffaqiyatli yangilandi!');
  } catch (err) {
    console.error('Pinterest rasmlarini yangilashda xato:', err.message);
  }
}

// 40 HD Pinterest Car Images list
const PINTEREST_CAR_IMAGES = [
  "https://i.pinimg.com/736x/7a/2e/76/7a2e76dbc30dd0fc0bb9b155a41ef725.jpg",
  "https://i.pinimg.com/736x/20/52/83/2052830dd25568deb458e4aa9996ac10.jpg",
  "https://i.pinimg.com/736x/04/36/b0/0436b05303daa36b9e53f2e2ad5fd271.jpg",
  "https://i.pinimg.com/736x/12/65/b3/1265b3fcbb7c43e91c5f5bad92db8ddb.jpg",
  "https://i.pinimg.com/736x/c2/f9/75/c2f975fd196a77c40e2b09b31605829b.jpg",
  "https://i.pinimg.com/736x/af/ad/cd/afadcdbcbe8b270111c67ce5bba45921.jpg",
  "https://i.pinimg.com/736x/34/93/62/34936201041fb5721920136ee13ce924.jpg",
  "https://i.pinimg.com/736x/0a/5d/cd/0a5dcd632356ee12603f6a5b68c1727d.jpg",
  "https://i.pinimg.com/736x/59/b3/8f/59b38fb3499068de7c2bd490820071ab.jpg",
  "https://i.pinimg.com/736x/85/67/5d/85675d243437e51683e603dd607ab9ec.jpg",
  "https://i.pinimg.com/736x/1e/22/62/1e2262fe02bbf8a31ba60328d249d741.jpg",
  "https://i.pinimg.com/736x/28/62/94/286294118cc66985c6ee9d732b51e46b.jpg",
  "https://i.pinimg.com/736x/47/8b/f6/478bf61e4712ba383a76118a6558bfd4.jpg",
  "https://i.pinimg.com/736x/b9/55/64/b955640a5f38367534f086184bd9c642.jpg",
  "https://i.pinimg.com/736x/4b/ea/b1/4beab1a8f8805ee53e3eb53941798c46.jpg",
  "https://i.pinimg.com/736x/19/56/d8/1956d87618817ccd8be1addcf83adc62.jpg",
  "https://i.pinimg.com/736x/01/98/fb/0198fbefa0f099f0658146b8583bf721.jpg",
  "https://i.pinimg.com/736x/e5/ac/a0/e5aca01399c8a6ebd70129c9bf34fda8.jpg",
  "https://i.pinimg.com/736x/97/03/52/9703528e598c3ff3bf5328bdb776fc69.jpg",
  "https://i.pinimg.com/736x/09/f5/c9/09f5c940fc50f0f6abddf6946971e233.jpg",
  "https://i.pinimg.com/736x/f9/7b/3f/f97b3fa089027b813c2c0a41d91730a4.jpg",
  "https://i.pinimg.com/736x/b4/60/08/b460082a0796694ef68bdc8e5e268924.jpg",
  "https://i.pinimg.com/736x/ba/a4/9c/baa49cadc14ec6cffe3e0c246939cf6b.jpg",
  "https://i.pinimg.com/736x/e2/d4/40/e2d4408b2a223bf0d4fed9f4e4cbdb5d.jpg",
  "https://i.pinimg.com/736x/99/17/17/991717216face66b88fdabebfb20ce4d.jpg",
  "https://i.pinimg.com/736x/3f/05/84/3f0584400a4d54964f3af78f29959e90.jpg",
  "https://i.pinimg.com/736x/e6/d4/55/e6d455913972f456466501091edd9501.jpg",
  "https://i.pinimg.com/736x/87/e7/8b/87e78bb57b0f714a45614056c7ac7865.jpg",
  "https://i.pinimg.com/736x/3d/f1/e9/3df1e98a8f697aae58cc5585cf9a4196.jpg",
  "https://i.pinimg.com/736x/fd/ad/ee/fdadee303a735a5bb324838c264c0dd2.jpg",
  "https://i.pinimg.com/736x/5d/0a/d9/5d0ad929f7aa7bcba6e5f2206561c227.jpg",
  "https://i.pinimg.com/736x/fe/55/13/fe551359b1029547f0cc8de557b9fffc.jpg",
  "https://i.pinimg.com/736x/c1/6d/0b/c16d0b022242f0254ad429d74e3f26d0.jpg",
  "https://i.pinimg.com/736x/d9/89/fd/d989fd96ed21abb2e243465045fbeb64.jpg",
  "https://i.pinimg.com/736x/22/30/dc/2230dca1329b6b58aa7c32eae776babe.jpg",
  "https://i.pinimg.com/736x/db/37/64/db37646202fc616f005db48c26176c72.jpg",
  "https://i.pinimg.com/736x/69/05/97/6905972dded36e3b06f5d39cecd6d4bf.jpg",
  "https://i.pinimg.com/736x/ba/79/4e/ba794ebea0adffe12a3c92d9d42aa445.jpg",
  "https://i.pinimg.com/736x/c7/22/b7/c722b70cedb8637dbb83ca822c79a23b.jpg",
  "https://i.pinimg.com/736x/db/b0/28/dbb0285975ebe342f80d87f36eb4e8ac.jpg"
];

seedInitialData();

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serve static uploaded files
app.use('/uploads', express.static(uploadsDir));

// Serve frontend directory
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// Serve frontend.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'frontend.html'));
});

// Get 40 HD Pinterest Car Photos
app.get('/api/pinterest-photos', (req, res) => {
  res.json({
    success: true,
    count: PINTEREST_CAR_IMAGES.length,
    photos: PINTEREST_CAR_IMAGES
  });
});

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Iltimos, tizimga kiring.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Sessiya muddati tugagan yoki noto‘g‘ri token.' });
    }
    req.user = decoded;
    next();
  });
}

// Optional Auth (for public routes that customize view if logged in)
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (!err) req.user = decoded;
      next();
    });
  } else {
    next();
  }
}

// Helper: send email via Resend
// Helper: send email via Resend SDK
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.log(`[EMAIL SIMULATED] To: ${to} | Subject: ${subject}`);
    return { success: true, simulated: true };
  }

  // 1. Try official Resend SDK
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: [to],
        subject: subject,
        html: html
      });
      if (data && data.id) {
        console.log(`✉️ [Resend SDK] Email muvaffaqiyatli yetkazildi: ${to} (ID: ${data.id})`);
        return { success: true, data };
      }
      if (error) {
        console.warn(`⚠️ [Resend SDK xatosi]:`, error.message || error);
      }
    } catch (sdkErr) {
      console.warn(`⚠️ [Resend SDK exception]:`, sdkErr.message);
    }
  }

  // 2. Direct HTTPS fallback
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject: subject,
      html: html
    });
    const req = https.request({
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✉️ [Resend HTTPS] Email muvaffaqiyatli yetkazildi: ${to} (ID: ${parsed.id})`);
            resolve({ success: true, data: parsed });
          } else {
            console.warn(`⚠️ [Resend HTTPS] Javob (${res.statusCode}):`, parsed.message || parsed);
            resolve({ success: false, error: parsed });
          }
        } catch (e) {
          resolve({ success: false, error: body });
        }
      });
    });
    req.on('error', err => {
      console.error('Email yuborishda xatolik:', err.message);
      resolve({ success: false, error: err.message });
    });
    req.write(payload);
    req.end();
  });
}

// Helper: create notification in DB
function createNotification(userId, type, title, message, link = '') {
  try {
    const stmt = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(userId, type, title, message, link);
  } catch (e) {
    console.error('Notification yaratishda xato:', e.message);
  }
}

// ==========================================
// ==========================================
// EMAIL OTP (CODE-BASED) LOGIN / REGISTRATION
// ==========================================

// 1. Send OTP code to email
app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Iltimos, to‘g‘ri email manzil kiriting.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user exists, if not create new user profile
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      const emailPrefix = cleanEmail.split('@')[0];
      const defaultName = emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);
      const defaultPassHash = bcrypt.hashSync(Math.random().toString(36) + Date.now().toString(), 10);
      const defaultAvatar = 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80';

      const insert = db.prepare(`
        INSERT INTO users (name, surname, email, password_hash, avatar_url, email_verified, role)
        VALUES (?, '', ?, ?, ?, 0, 'user')
      `);
      const result = insert.run(defaultName, cleanEmail, defaultPassHash, defaultAvatar);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
      console.log(`👤 Yangi user yaratildi: ${cleanEmail} (ID: ${user.id})`);
    }

    // Generate 6 digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(user.id);
    db.prepare(`
      INSERT INTO verification_codes (user_id, email, code, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, cleanEmail, code, expiresAt);

    // Send formatted HTML email via Resend
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #16a34a; font-size: 26px; margin: 0; font-weight: 800;">🚗 AvtoRent</h1>
          <p style="color: #64748b; font-size: 14px; margin-top: 4px;">O‘zbekistondagi zamonaviy avtomobil ijarasi</p>
        </div>
        <p style="font-size: 16px; color: #0f172a; margin-bottom: 8px;">Assalomu alaykum!</p>
        <p style="font-size: 14px; color: #475569; line-height: 1.6; margin-bottom: 24px;">
          AvtoRent tizimiga kirish uchun tasdiqlash kodingiz:
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <span style="display: inline-block; font-size: 36px; letter-spacing: 10px; font-weight: 800; color: #16a34a; background: #f0fdf4; padding: 14px 28px; border-radius: 12px; border: 2px dashed #22c55e;">
            ${code}
          </span>
        </div>
        <p style="font-size: 13px; color: #94a3b8; text-align: center; margin-bottom: 24px;">Ushbu kod 10 daqiqa davomida amal qiladi.</p>
        <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
        <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">Agar bu so‘rovni siz yubormagan bo‘lsangiz, xatni e‘tiborsiz qoldiring.</p>
      </div>
    `;

    sendEmail({
      to: cleanEmail,
      subject: `AvtoRent — Tasdiqlash kodi: ${code}`,
      html: emailHtml
    });

    console.log(`🔑 [EMAIL OTP]: ${cleanEmail} ga kod yuborildi: ${code}`);

    res.json({
      success: true,
      message: `Tasdiqlash kodi emailingizga (${cleanEmail}) yuborildi.`,
      email: cleanEmail,
      dev_code: code
    });
  } catch (err) {
    console.error('Send code xatosi:', err);
    res.status(500).json({ success: false, message: 'Kodni yuborishda serverda xatolik.' });
  }
});

// 2. Verify OTP code and Login
app.post('/api/auth/verify-code', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email va tasdiqlash kodini kiriting.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi.' });
    }

    const record = db.prepare(`
      SELECT * FROM verification_codes 
      WHERE user_id = ? AND code = ? 
      ORDER BY id DESC LIMIT 1
    `).get(user.id, code.trim());

    if (!record) {
      return res.status(400).json({ success: false, message: 'Tasdiqlash kodi noto‘g‘ri.' });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Kodning amal qilish muddati tugagan. Qaytadan so‘rang.' });
    }

    // Mark email verified
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(user.id);

    // Issue JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    createNotification(user.id, 'WELCOME', 'Xush kelibsiz!', 'AvtoRent tizimiga muvaffaqiyatli kirdingiz.');

    res.json({
      success: true,
      message: 'Muvaffaqiyatli kirdingiz!',
      token,
      user: {
        id: user.id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        phone: user.phone,
        avatar_url: user.avatar_url,
        email_verified: 1,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Verify code xatosi:', err);
    res.status(500).json({ success: false, message: 'Kodni tekshirishda xatolik yuz berdi.' });
  }
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, surname, email, password, password_confirm } = req.body;

    if (!name || !surname || !email || !password) {
      return res.status(400).json({ success: false, message: 'Barcha maydonlarni to‘ldiring.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Parol kamida 6 belgidan iborat bo‘lishi kerak.' });
    }
    if (password_confirm && password !== password_confirm) {
      return res.status(400).json({ success: false, message: 'Parollar mos kelmadi.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Bu email bilan allaqachon ro‘yxatdan o‘tilgan.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const insert = db.prepare(`
      INSERT INTO users (name, surname, email, password_hash, email_verified)
      VALUES (?, ?, ?, ?, 0)
    `);
    const result = insert.run(name.trim(), surname.trim(), cleanEmail, passwordHash);
    const userId = Number(result.lastInsertRowid);

    // Generate 6 digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(userId);
    db.prepare(`
      INSERT INTO verification_codes (user_id, email, code, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, cleanEmail, code, expiresAt);

    // Send verification email via Resend
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #16a34a; font-size: 26px; margin: 0;">🚗 AvtoRent</h1>
          <p style="color: #64748b; font-size: 14px; margin-top: 4px;">O‘zbekistondagi zamonaviy avtomobil ijarasi</p>
        </div>
        <p style="font-size: 16px; color: #1e293b;">Assalomu alaykum, <b>${name}</b>!</p>
        <p style="font-size: 14px; color: #475569; line-height: 1.6;">
          AvtoRent platformasiga xush kelibsiz. Hisobingizni tasdiqlash uchun quyidagi 6 xonali tasdiqlash kodidan foydalaning:
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <span style="display: inline-block; font-size: 32px; letter-spacing: 8px; font-weight: bold; color: #16a34a; background: #f0fdf4; padding: 12px 24px; border-radius: 10px; border: 1px dashed #22c55e;">
            ${code}
          </span>
        </div>
        <p style="font-size: 13px; color: #94a3b8; text-align: center;">Ushbu kod 10 daqiqa davomida amal qiladi.</p>
        <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
        <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">Agar bu so‘rovni siz yubormagan bo‘lsangiz, ushbu xatni e‘tiborsiz qoldiring.</p>
      </div>
    `;

    sendEmail({
      to: cleanEmail,
      subject: 'AvtoRent — Email tasdiqlash kodi',
      html: emailHtml
    }).then(res => console.log(`[Resend Verification Email] to: ${cleanEmail}, code: ${code}`));

    console.log(`🔑 [EMAIL CODE LOG]: ${cleanEmail} uchun kod: ${code}`);

    res.json({
      success: true,
      message: 'Ro‘yxatdan o‘tish muvaffaqiyatli! Emailingizga tasdiqlash kodi yuborildi.',
      userId,
      email: cleanEmail,
      dev_code: code // Seamless testing convenience
    });
  } catch (err) {
    console.error('Register xatosi:', err);
    res.status(500).json({ success: false, message: 'Serverda xatolik yuz berdi.' });
  }
});

// Verify Email
app.post('/api/auth/verify-email', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email va tasdiqlash kodini kiriting.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi.' });
    }

    const record = db.prepare(`
      SELECT * FROM verification_codes 
      WHERE user_id = ? AND code = ? 
      ORDER BY id DESC LIMIT 1
    `).get(user.id, code.trim());

    if (!record) {
      return res.status(400).json({ success: false, message: 'Tasdiqlash kodi noto‘g‘ri.' });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Kodning amal qilish muddati tugagan. Qaytadan so‘rang.' });
    }

    // Mark verified
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(user.id);

    // Issue JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    createNotification(user.id, 'WELCOME', 'Xush kelibsiz!', 'Profilingiz va emailingiz muvaffaqiyatli tasdiqlandi.');

    res.json({
      success: true,
      message: 'Email muvaffaqiyatli tasdiqlandi!',
      token,
      user: {
        id: user.id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        phone: user.phone,
        avatar_url: user.avatar_url,
        email_verified: 1,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Verify email xatosi:', err);
    res.status(500).json({ success: false, message: 'Serverda xatolik yuz berdi.' });
  }
});

// Resend Code
app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email kiritilmadi.' });

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(user.id);
    db.prepare(`
      INSERT INTO verification_codes (user_id, email, code, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, cleanEmail, code, expiresAt);

    sendEmail({
      to: cleanEmail,
      subject: 'AvtoRent — Yangi tasdiqlash kodi',
      html: `<p>Sizning yangi tasdiqlash kodingiz: <b>${code}</b> (10 daqiqa amal qiladi)</p>`
    });

    console.log(`🔑 [YANGI EMAIL KODI]: ${cleanEmail} -> ${code}`);

    res.json({
      success: true,
      message: 'Yangi tasdiqlash kodi yuborildi.',
      dev_code: code
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email va parolni kiriting.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      return res.status(400).json({ success: false, message: 'Email yoki parol noto‘g‘ri.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Email yoki parol noto‘g‘ri.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Xush kelibsiz!',
      token,
      user: {
        id: user.id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        phone: user.phone,
        avatar_url: user.avatar_url,
        email_verified: user.email_verified,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login xatosi:', err);
    res.status(500).json({ success: false, message: 'Serverda xatolik yuz berdi.' });
  }
});

// Get Current User Profile & Stats
app.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare(`
      SELECT id, name, surname, email, phone, avatar_url, email_verified, role, google_id, created_at 
      FROM users WHERE id = ?
    `).get(req.user.id);

    if (!user) return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi.' });

    const carsCount = db.prepare('SELECT COUNT(*) as count FROM cars WHERE owner_id = ?').get(user.id).count;
    const rentalsCount = db.prepare('SELECT COUNT(*) as count FROM rentals WHERE renter_id = ? OR owner_id = ?').get(user.id, user.id).count;
    const unreadNotifications = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).count;
    const unreadMessages = db.prepare(`
      SELECT COUNT(*) as count FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE (c.renter_id = ? OR c.owner_id = ?) AND m.sender_id != ? AND m.is_read = 0
    `).get(user.id, user.id, user.id).count;

    res.json({
      success: true,
      user: {
        ...user,
        stats: {
          carsCount,
          rentalsCount,
          unreadNotifications,
          unreadMessages
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// Forgot Password
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email kiritilmadi.' });

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      // Don't reveal if user exists for security
      return res.json({ success: true, message: 'Agar bu email mavjud bo‘lsa, tiklash kodi yuborildi.' });
    }

    const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, resetToken, expiresAt);

    sendEmail({
      to: cleanEmail,
      subject: 'AvtoRent — Parolni qayta tiklash',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h3>Parolni tiklash kodi</h3>
          <p>Sizning parolni tiklash kodingiz: <b style="font-size: 22px; color: #16a34a;">${resetToken}</b></p>
          <p>Ushbu kod 15 daqiqa davomida amal qiladi.</p>
        </div>
      `
    });

    console.log(`🔑 [PASSWORD RESET CODE]: ${cleanEmail} -> ${resetToken}`);

    res.json({
      success: true,
      message: 'Parolni tiklash kodi emailingizga yuborildi.',
      dev_code: resetToken
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// Reset Password
app.post('/api/auth/reset-password', (req, res) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password) {
      return res.status(400).json({ success: false, message: 'Barcha maydonlarni to‘ldiring.' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Parol kamida 6 belgidan iborat bo‘lsin.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi.' });

    const record = db.prepare(`
      SELECT * FROM password_resets 
      WHERE user_id = ? AND token = ? 
      ORDER BY id DESC LIMIT 1
    `).get(user.id, code.trim());

    if (!record) return res.status(400).json({ success: false, message: 'Tiklash kodi noto‘g‘ri.' });
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Kodning amal qilish muddati tugagan.' });
    }

    const newHash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);

    res.json({ success: true, message: 'Parolingiz muvaffaqiyatli yangilandi! Endi yangi parol bilan kiring.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true, message: 'Tizimdan chiqildi.' });
});

// ==========================================
// GOOGLE OAUTH 2.0 AUTHENTICATION
// ==========================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback';

// 1. Initiate Google OAuth
app.get('/api/auth/google', (req, res) => {
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    const scope = encodeURIComponent('openid profile email');
    const redirectUri = encodeURIComponent(GOOGLE_CALLBACK_URL);
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=select_account`;
    return res.redirect(googleAuthUrl);
  }

  // Developer Simulation fallback if GOOGLE_CLIENT_ID is not configured in .env yet
  res.send(`
    <!DOCTYPE html>
    <html lang="uz">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Google bilan davom etish — AvtoRent</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: white; border-radius: 16px; padding: 32px; max-width: 440px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        .google-logo { width: 44px; height: 44px; margin-bottom: 16px; }
        h2 { font-size: 20px; color: #0f172a; margin-top: 0; margin-bottom: 6px; }
        p { color: #64748b; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
        .acc-item { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 12px; cursor: pointer; text-decoration: none; color: inherit; transition: all 0.2s; }
        .acc-item:hover { border-color: #16a34a; background: #f0fdf4; }
        .acc-avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
        .btn-custom { width: 100%; padding: 12px; background: #16a34a; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; margin-top: 10px; }
        input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; margin-bottom: 10px; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <svg class="google-logo" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        <h2>Google hisobi orqali kirish</h2>
        <p>Google orqali AvtoRent tizimiga kirish uchun hisobingizni tanlang:</p>
        
        <a href="/api/auth/google/callback?mock=true&email=siusbknczd@gmail.com&name=Sayfulloh&surname=Sharipov" class="acc-item">
          <img src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&q=80" class="acc-avatar">
          <div>
            <div style="font-weight: 700; font-size: 15px;">Sayfulloh Sharipov</div>
            <div style="font-size: 13px; color: #64748b;">siusbknczd@gmail.com</div>
          </div>
        </a>

        <a href="/api/auth/google/callback?mock=true&email=user_google@gmail.com&name=Temur&surname=Yusupov" class="acc-item">
          <img src="https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?auto=format&fit=crop&w=100&q=80" class="acc-avatar">
          <div>
            <div style="font-weight: 700; font-size: 15px;">Temur Yusupov (Yangi foydalanuvchi)</div>
            <div style="font-size: 13px; color: #64748b;">user_google@gmail.com</div>
          </div>
        </a>

        <div style="margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
          <div style="font-size: 13px; font-weight: 600; color: #64748b; margin-bottom: 8px;">Yoki boshqa Google hisobini kiriting:</div>
          <form method="GET" action="/api/auth/google/callback">
            <input type="hidden" name="mock" value="true">
            <input type="text" name="name" placeholder="Ismingiz (masalan: Jasur)" required>
            <input type="text" name="surname" placeholder="Familiyangiz (masalan: Qodirov)" required>
            <input type="email" name="email" placeholder="Google emailingiz (masalan: jasur@gmail.com)" required>
            <button type="submit" class="btn-custom">🌐 Ushbu Google hisobi bilan kirish</button>
          </form>
        </div>
      </div>
    </body>
    </html>
  `);
});

// 2. Google OAuth Callback
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    let googleUser = null;

    if (req.query.mock === 'true') {
      googleUser = {
        sub: 'mock_google_' + (req.query.email || 'user').replace(/[^a-zA-Z0-9]/g, '_'),
        name: (req.query.name || 'Google') + ' ' + (req.query.surname || 'Foydalanuvchi'),
        given_name: req.query.name || 'Google',
        family_name: req.query.surname || 'Foydalanuvchi',
        email: (req.query.email || 'user_google@gmail.com').trim().toLowerCase(),
        picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80',
        email_verified: true
      };
    } else {
      const code = req.query.code;
      if (!code) {
        return res.status(400).send('Google avtorizatsiya kodi olinmadi.');
      }

      // Exchange code for token with Google
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_CALLBACK_URL,
          grant_type: 'authorization_code'
        })
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.access_token) {
        console.error('Google token error:', tokenData);
        return res.status(400).send('Google token olishda xatolik yuz berdi: ' + JSON.stringify(tokenData));
      }

      // Fetch user profile from Google
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      googleUser = await userInfoResponse.json();
    }

    if (!googleUser || !googleUser.email) {
      return res.status(400).send('Google foydalanuvchi ma‘lumotlari olinmadi.');
    }

    const cleanEmail = googleUser.email.trim().toLowerCase();
    const googleId = googleUser.sub || '';
    const firstName = googleUser.given_name || googleUser.name?.split(' ')[0] || 'Foydalanuvchi';
    const lastName = googleUser.family_name || googleUser.name?.split(' ').slice(1).join(' ') || '';
    const avatarUrl = googleUser.picture || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80';

    // Check if user already exists by google_id or email
    let user = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(googleId, cleanEmail);

    if (user) {
      // Existing user: ensure google_id and email_verified = 1
      db.prepare(`
        UPDATE users SET 
          google_id = COALESCE(google_id, ?),
          email_verified = 1,
          avatar_url = CASE WHEN avatar_url = '' OR avatar_url IS NULL THEN ? ELSE avatar_url END
        WHERE id = ?
      `).run(googleId, avatarUrl, user.id);
      
      // Refresh user record
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    } else {
      // Create new user
      const randomPassHash = bcrypt.hashSync(Math.random().toString(36) + Date.now().toString(), 10);
      const insert = db.prepare(`
        INSERT INTO users (name, surname, email, password_hash, avatar_url, email_verified, role, google_id)
        VALUES (?, ?, ?, ?, ?, 1, 'user', ?)
      `);
      const result = insert.run(firstName, lastName, cleanEmail, randomPassHash, avatarUrl, googleId);
      const userId = Number(result.lastInsertRowid);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      createNotification(user.id, 'WELCOME', 'Xush kelibsiz!', 'Google hisobingiz orqali ro‘yxatdan muvaffaqiyatli o‘tdingiz.');
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Send redirect script to browser
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Google Kirish — AvtoRent</title>
      </head>
      <body>
        <script>
          try {
            localStorage.setItem('avtorent_token', '${token}');
            window.location.href = '/?google_login=success';
          } catch(e) {
            window.location.href = '/';
          }
        </script>
        <p style="font-family: sans-serif; text-align: center; margin-top: 50px; color: #16a34a; font-weight: bold;">
          Google orqali tizimga muvaffaqiyatli kirdingiz! Yo‘naltirilmoqda...
        </p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Google callback error:', err);
    res.status(500).send('Google avtorizatsiyasida server xatosi: ' + err.message);
  }
});

// ==========================================
// FILE UPLOAD API (Images)
// ==========================================
app.post('/api/upload', authenticateToken, (req, res) => {
  try {
    const { base64Data, fileName } = req.body;
    if (!base64Data) {
      return res.status(400).json({ success: false, message: 'Rasm ma‘lumotlari yuborilmadi.' });
    }

    // Match data:image/png;base64,...
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ success: false, message: 'Noto‘g‘ri rasm formati.' });
    }

    const ext = matches[1].split('/')[1] || 'jpg';
    const buffer = Buffer.from(matches[2], 'base64');
    const safeName = `img_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
    const filePath = path.join(uploadsDir, safeName);

    fs.writeFileSync(filePath, buffer);
    const url = `/uploads/${safeName}`;

    res.json({ success: true, url });
  } catch (err) {
    console.error('Rasm yuklashda xato:', err);
    res.status(500).json({ success: false, message: 'Rasm saqlashda xatolik yuz berdi.' });
  }
});

// ==========================================
// CARS API
// ==========================================

// Get Cars list with filters & sorting & sections
app.get('/api/cars', optionalAuth, (req, res) => {
  try {
    const {
      search,
      brand,
      model,
      body_type,
      transmission,
      fuel_type,
      min_price,
      max_price,
      region,
      section,
      sort
    } = req.query;

    let query = `
      SELECT c.*, u.name as owner_name, u.surname as owner_surname, u.phone as owner_phone, u.avatar_url as owner_avatar
      FROM cars c
      JOIN users u ON c.owner_id = u.id
      WHERE c.status = 'ACTIVE'
    `;
    const params = [];

    if (search && search.trim()) {
      query += ` AND (c.brand LIKE ? OR c.model LIKE ? OR c.region LIKE ? OR c.city LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
    }
    if (brand && brand !== 'all') {
      query += ` AND c.brand = ?`;
      params.push(brand);
    }
    if (model && model.trim()) {
      query += ` AND c.model LIKE ?`;
      params.push(`%${model.trim()}%`);
    }
    if (body_type && body_type !== 'all') {
      query += ` AND c.body_type = ?`;
      params.push(body_type);
    }
    if (transmission && transmission !== 'all') {
      query += ` AND c.transmission = ?`;
      params.push(transmission);
    }
    if (fuel_type && fuel_type !== 'all') {
      query += ` AND c.fuel_type = ?`;
      params.push(fuel_type);
    }
    if (region && region !== 'all') {
      query += ` AND c.region LIKE ?`;
      params.push(`%${region}%`);
    }
    if (min_price) {
      query += ` AND c.daily_price >= ?`;
      params.push(Number(min_price));
    }
    if (max_price) {
      query += ` AND c.daily_price <= ?`;
      params.push(Number(max_price));
    }

    // Section filters
    if (section === 'popular') {
      query += ` AND c.rating >= 4.8`;
    } else if (section === 'new') {
      // Latest created
    } else if (section === 'premium') {
      query += ` AND c.daily_price >= 800000`;
    } else if (section === 'budget') {
      query += ` AND c.daily_price <= 450000`;
    }

    // Sorting
    if (sort === 'price_asc') {
      query += ` ORDER BY c.daily_price ASC`;
    } else if (sort === 'price_desc') {
      query += ` ORDER BY c.daily_price DESC`;
    } else if (sort === 'rating') {
      query += ` ORDER BY c.rating DESC, c.review_count DESC`;
    } else {
      query += ` ORDER BY c.id DESC`;
    }

    const cars = db.prepare(query).all(...params);

    // If user is authenticated, check which cars are in favorites
    let favoriteCarIds = new Set();
    if (req.user) {
      const favs = db.prepare('SELECT car_id FROM favorites WHERE user_id = ?').all(req.user.id);
      favs.forEach(f => favoriteCarIds.add(f.car_id));
    }

    const enrichedCars = cars.map(car => ({
      ...car,
      is_favorite: favoriteCarIds.has(car.id)
    }));

    res.json({ success: true, cars: enrichedCars, count: enrichedCars.length });
  } catch (err) {
    console.error('Cars list xatosi:', err);
    res.status(500).json({ success: false, message: 'Mashinalarni yuklashda xatolik.' });
  }
});

// Get Single Car Details
app.get('/api/cars/:id', optionalAuth, (req, res) => {
  try {
    const carId = Number(req.params.id);
    const car = db.prepare(`
      SELECT c.*, 
             u.id as owner_id, u.name as owner_name, u.surname as owner_surname, 
             u.phone as owner_phone, u.avatar_url as owner_avatar, u.created_at as owner_since,
             u.email_verified as owner_verified
      FROM cars c
      JOIN users u ON c.owner_id = u.id
      WHERE c.id = ?
    `).get(carId);

    if (!car) {
      return res.status(404).json({ success: false, message: 'Mashina topilmadi.' });
    }

    // Get all images
    const images = db.prepare('SELECT id, image_url, tag FROM car_images WHERE car_id = ? ORDER BY id ASC').all(carId);

    // Get reviews
    const reviews = db.prepare(`
      SELECT r.*, u.name as user_name, u.avatar_url as user_avatar
      FROM reviews r
      JOIN users u ON r.user_id = u.id
      WHERE r.car_id = ?
      ORDER BY r.created_at DESC
    `).all(carId);

    // Get booked date intervals
    const bookedRentals = db.prepare(`
      SELECT start_date, end_date, status 
      FROM rentals 
      WHERE car_id = ? AND status IN ('CONFIRMED', 'ACTIVE', 'PENDING')
    `).all(carId);

    // Check favorite
    let isFavorite = false;
    if (req.user) {
      const fav = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND car_id = ?').get(req.user.id, carId);
      isFavorite = !!fav;
    }

    res.json({
      success: true,
      car: {
        ...car,
        images: images.length > 0 ? images.map(img => img.image_url) : [car.main_image],
        reviews,
        bookedRentals,
        is_favorite: isFavorite,
        is_owner: req.user ? req.user.id === car.owner_id : false
      }
    });
  } catch (err) {
    console.error('Car detail xatosi:', err);
    res.status(500).json({ success: false, message: 'Serverda xatolik yuz berdi.' });
  }
});

// Create Car (8-step form submission)
app.post('/api/cars', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
    if (!user || !user.email_verified) {
      return res.status(403).json({
        success: false,
        message: 'Mashina joylash uchun avval emailingizni tasdiqlang.'
      });
    }

    const {
      brand,
      model,
      year,
      color,
      body_type,
      transmission,
      fuel_type,
      seats,
      mileage,
      region,
      city,
      district,
      pickup_address,
      daily_price,
      deposit,
      min_rental_days,
      min_age,
      min_experience,
      daily_km_limit,
      smoking_allowed,
      pets_allowed,
      abroad_allowed,
      extra_rules,
      images // array of image URLs (min 3, max 8)
    } = req.body;

    if (!brand || !model || !year || !daily_price || !region || !city) {
      return res.status(400).json({ success: false, message: 'Asosiy maydonlarni to‘ldiring.' });
    }

    if (!images || !Array.isArray(images) || images.length < 3) {
      return res.status(400).json({ success: false, message: 'Kamida 3 ta mashina rasmini yuklang.' });
    }

    const mainImage = images[0];

    const insert = db.prepare(`
      INSERT INTO cars (
        owner_id, brand, model, year, color, body_type, transmission, fuel_type,
        seats, mileage, region, city, district, pickup_address, daily_price,
        deposit, min_rental_days, min_age, min_experience, daily_km_limit,
        smoking_allowed, pets_allowed, abroad_allowed, extra_rules, status,
        rating, review_count, main_image
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 5.0, 1, ?)
    `);

    const result = insert.run(
      req.user.id,
      brand.trim(),
      model.trim(),
      Number(year) || 2023,
      color || 'Oq',
      body_type || 'Sedan',
      transmission || 'Avtomat',
      fuel_type || 'Benzin',
      Number(seats) || 5,
      Number(mileage) || 0,
      region.trim(),
      city.trim(),
      district || '',
      pickup_address || '',
      Number(daily_price),
      Number(deposit) || 0,
      Number(min_rental_days) || 1,
      Number(min_age) || 21,
      Number(min_experience) || 1,
      Number(daily_km_limit) || 300,
      smoking_allowed ? 1 : 0,
      pets_allowed ? 1 : 0,
      abroad_allowed ? 1 : 0,
      extra_rules || '',
      mainImage
    );

    const carId = Number(result.lastInsertRowid);

    // Insert all uploaded images
    const insertImg = db.prepare('INSERT INTO car_images (car_id, image_url, tag) VALUES (?, ?, ?)');
    images.forEach((imgUrl, idx) => {
      insertImg.run(carId, imgUrl, idx === 0 ? 'main' : 'gallery');
    });

    createNotification(req.user.id, 'CAR_CREATED', 'E‘lon chop etildi!', `${brand} ${model} muvaffaqiyatli joylashtirildi.`, `/cars/${carId}`);

    res.json({
      success: true,
      message: 'Mashinangiz muvaffaqiyatli joylashtirildi!',
      carId
    });
  } catch (err) {
    console.error('Car creation xatosi:', err);
    res.status(500).json({ success: false, message: 'Mashina qo‘shishda xatolik yuz berdi.' });
  }
});

// Update Car
app.put('/api/cars/:id', authenticateToken, (req, res) => {
  try {
    const carId = Number(req.params.id);
    const car = db.prepare('SELECT owner_id FROM cars WHERE id = ?').get(carId);

    if (!car) return res.status(404).json({ success: false, message: 'Mashina topilmadi.' });
    if (car.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Bu mashinani faqat egasi tahrirlashi mumkin.' });
    }

    const {
      brand, model, year, color, body_type, transmission, fuel_type,
      seats, mileage, region, city, pickup_address, daily_price, deposit,
      min_rental_days, status, extra_rules
    } = req.body;

    db.prepare(`
      UPDATE cars SET 
        brand = COALESCE(?, brand),
        model = COALESCE(?, model),
        year = COALESCE(?, year),
        color = COALESCE(?, color),
        body_type = COALESCE(?, body_type),
        transmission = COALESCE(?, transmission),
        fuel_type = COALESCE(?, fuel_type),
        seats = COALESCE(?, seats),
        mileage = COALESCE(?, mileage),
        region = COALESCE(?, region),
        city = COALESCE(?, city),
        pickup_address = COALESCE(?, pickup_address),
        daily_price = COALESCE(?, daily_price),
        deposit = COALESCE(?, deposit),
        min_rental_days = COALESCE(?, min_rental_days),
        status = COALESCE(?, status),
        extra_rules = COALESCE(?, extra_rules)
      WHERE id = ?
    `).run(
      brand, model, year ? Number(year) : null, color, body_type, transmission, fuel_type,
      seats ? Number(seats) : null, mileage ? Number(mileage) : null, region, city,
      pickup_address, daily_price ? Number(daily_price) : null, deposit ? Number(deposit) : null,
      min_rental_days ? Number(min_rental_days) : null, status, extra_rules,
      carId
    );

    res.json({ success: true, message: 'Mashina ma‘lumotlari muvaffaqiyatli yangilandi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Serverda xatolik yuz berdi.' });
  }
});

// Delete Car
app.delete('/api/cars/:id', authenticateToken, (req, res) => {
  try {
    const carId = Number(req.params.id);
    const car = db.prepare('SELECT owner_id FROM cars WHERE id = ?').get(carId);

    if (!car) return res.status(404).json({ success: false, message: 'Mashina topilmadi.' });
    if (car.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Siz bu mashinani o‘chira olmaysiz.' });
    }

    db.prepare('DELETE FROM cars WHERE id = ?').run(carId);
    res.json({ success: true, message: 'Mashina o‘chirildi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// My Cars
app.get('/api/my-cars', authenticateToken, (req, res) => {
  try {
    const cars = db.prepare(`
      SELECT c.*, 
             (SELECT COUNT(*) FROM rentals r WHERE r.car_id = c.id AND r.status = 'PENDING') as pending_requests
      FROM cars c
      WHERE c.owner_id = ?
      ORDER BY c.id DESC
    `).all(req.user.id);

    res.json({ success: true, cars });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Mashinalarni yuklashda xatolik.' });
  }
});

// ==========================================
// FAVORITES API
// ==========================================
app.post('/api/cars/:id/favorite', authenticateToken, (req, res) => {
  try {
    const carId = Number(req.params.id);
    db.prepare(`
      INSERT OR IGNORE INTO favorites (user_id, car_id) VALUES (?, ?)
    `).run(req.user.id, carId);

    res.json({ success: true, message: 'Yoqtirganlarga qo‘shildi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

app.delete('/api/cars/:id/favorite', authenticateToken, (req, res) => {
  try {
    const carId = Number(req.params.id);
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND car_id = ?').run(req.user.id, carId);
    res.json({ success: true, message: 'Yoqtirganlardan olib tashlandi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

app.get('/api/favorites', authenticateToken, (req, res) => {
  try {
    const cars = db.prepare(`
      SELECT c.*, 1 as is_favorite, u.name as owner_name, u.surname as owner_surname
      FROM favorites f
      JOIN cars c ON f.car_id = c.id
      JOIN users u ON c.owner_id = u.id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
    `).all(req.user.id);

    res.json({ success: true, cars });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// ==========================================
// RENTALS API (With Server-side Double-booking Prevention)
// ==========================================

// Create rental request
app.post('/api/rentals', authenticateToken, (req, res) => {
  try {
    const { car_id, start_date, end_date } = req.body;

    if (!car_id || !start_date || !end_date) {
      return res.status(400).json({ success: false, message: 'Sanalar va mashinani tanlang.' });
    }

    const start = new Date(start_date);
    const end = new Date(end_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      return res.status(400).json({ success: false, message: 'O‘tgan sanani tanlab bo‘lmaydi.' });
    }
    if (end < start) {
      return res.status(400).json({ success: false, message: 'Tugash sanasi boshlanishidan oldin bo‘lishi mumkin emas.' });
    }

    const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(Number(car_id));
    if (!car) {
      return res.status(404).json({ success: false, message: 'Mashina topilmadi.' });
    }

    if (car.owner_id === req.user.id) {
      return res.status(400).json({ success: false, message: 'O‘z mashinangizni ijaraga ola olmaysiz.' });
    }

    // Calculate total days (inclusive of first and last day)
    const diffTime = Math.abs(end - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    if (diffDays < car.min_rental_days) {
      return res.status(400).json({
        success: false,
        message: `Ushbu mashina uchun minimal ijara muddati ${car.min_rental_days} kun.`
      });
    }

    // CRITICAL: Double-booking prevention check on the server
    // Check if any CONFIRMED or ACTIVE rental overlaps
    const conflict = db.prepare(`
      SELECT id FROM rentals 
      WHERE car_id = ? 
        AND status IN ('CONFIRMED', 'ACTIVE')
        AND NOT (end_date < ? OR start_date > ?)
    `).get(car.id, start_date, end_date);

    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'Kechirasiz, tanlangan sanalarda bu mashina allaqachon band qilingan.'
      });
    }

    const totalPrice = diffDays * car.daily_price;

    const insert = db.prepare(`
      INSERT INTO rentals (car_id, renter_id, owner_id, start_date, end_date, total_days, daily_price, total_price, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `);
    const result = insert.run(car.id, req.user.id, car.owner_id, start_date, end_date, diffDays, car.daily_price, totalPrice);
    const rentalId = Number(result.lastInsertRowid);

    // Notify Car Owner
    createNotification(
      car.owner_id,
      'RENTAL_REQUEST',
      'Yangi ijara so‘rovi!',
      `${req.user.name} sizning ${car.brand} ${car.model} mashinangizni ${diffDays} kunga (${start_date} - ${end_date}) ijaraga so‘radi.`,
      `/rentals`
    );

    // Get owner email to send notification
    const owner = db.prepare('SELECT email, name FROM users WHERE id = ?').get(car.owner_id);
    if (owner && owner.email) {
      sendEmail({
        to: owner.email,
        subject: `AvtoRent — Yangi ijara so‘rovi: ${car.brand} ${car.model}`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h3>Assalomu alaykum, ${owner.name}!</h3>
            <p>Foydalanuvchi sizning <b>${car.brand} ${car.model}</b> avtomobilingizni <b>${diffDays} kunga</b> ijaraga olish so‘rovini yubordi.</p>
            <p><b>Jami summa:</b> ${totalPrice.toLocaleString()} so‘m</p>
            <p><b>Sanalar:</b> ${start_date} dan ${end_date} gacha</p>
            <p>Ilovadagi "Mening ijaralarim" bo‘limidan so‘rovni qabul qilishingiz yoki rad etishingiz mumkin.</p>
          </div>
        `
      });
    }

    res.json({
      success: true,
      message: 'Ijara so‘rovi egasiga yuborildi! Egasi tasdiqlashini kuting.',
      rentalId,
      totalDays: diffDays,
      totalPrice
    });
  } catch (err) {
    console.error('Rental create xatosi:', err);
    res.status(500).json({ success: false, message: 'Ijara so‘rovini yuborishda xatolik.' });
  }
});

// Get user's rentals (as renter)
app.get('/api/rentals', authenticateToken, (req, res) => {
  try {
    const rentals = db.prepare(`
      SELECT r.*, 
             c.brand, c.model, c.year, c.main_image, c.region, c.city,
             u.name as owner_name, u.surname as owner_surname, u.phone as owner_phone, u.avatar_url as owner_avatar
      FROM rentals r
      JOIN cars c ON r.car_id = c.id
      JOIN users u ON r.owner_id = u.id
      WHERE r.renter_id = ?
      ORDER BY r.id DESC
    `).all(req.user.id);

    res.json({ success: true, rentals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ijaralarni yuklashda xatolik.' });
  }
});

// Get owner's incoming rental requests
app.get('/api/owner/rentals', authenticateToken, (req, res) => {
  try {
    const rentals = db.prepare(`
      SELECT r.*, 
             c.brand, c.model, c.year, c.main_image,
             u.name as renter_name, u.surname as renter_surname, u.phone as renter_phone, u.avatar_url as renter_avatar
      FROM rentals r
      JOIN cars c ON r.car_id = c.id
      JOIN users u ON r.renter_id = u.id
      WHERE r.owner_id = ?
      ORDER BY r.id DESC
    `).all(req.user.id);

    res.json({ success: true, rentals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ijaralarni yuklashda xatolik.' });
  }
});

// Accept Rental Request (Owner only)
app.post('/api/rentals/:id/accept', authenticateToken, (req, res) => {
  try {
    const rentalId = Number(req.params.id);
    const rental = db.prepare(`
      SELECT r.*, c.brand, c.model, u.email as renter_email, u.name as renter_name
      FROM rentals r
      JOIN cars c ON r.car_id = c.id
      JOIN users u ON r.renter_id = u.id
      WHERE r.id = ?
    `).get(rentalId);

    if (!rental) return res.status(404).json({ success: false, message: 'Ijara topilmadi.' });
    if (rental.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Faqat mashina egasi so‘rovni tasdiqlashi mumkin.' });
    }

    // Check again for conflicts before confirming
    const conflict = db.prepare(`
      SELECT id FROM rentals 
      WHERE car_id = ? AND id != ? AND status = 'CONFIRMED'
        AND NOT (end_date < ? OR start_date > ?)
    `).get(rental.car_id, rental.id, rental.start_date, rental.end_date);

    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'Ushbu sanalarga boshqa ijara tasdiqlangan. So‘rovni qabul qilib bo‘lmaydi.'
      });
    }

    db.prepare("UPDATE rentals SET status = 'CONFIRMED' WHERE id = ?").run(rentalId);

    // Reject other overlapping PENDING requests automatically
    db.prepare(`
      UPDATE rentals SET status = 'REJECTED'
      WHERE car_id = ? AND id != ? AND status = 'PENDING'
        AND NOT (end_date < ? OR start_date > ?)
    `).run(rental.car_id, rental.id, rental.start_date, rental.end_date);

    // Notify Renter
    createNotification(
      rental.renter_id,
      'RENTAL_CONFIRMED',
      'Ijara so‘rovingiz tasdiqlandi! 🎉',
      `${rental.brand} ${rental.model} uchun ijara so‘rovingiz qabul qilindi. Mashina egasi bilan chat orqali bog‘lanishingiz mumkin.`
    );

    // Send email to renter
    if (rental.renter_email) {
      sendEmail({
        to: rental.renter_email,
        subject: `AvtoRent — Ijara so‘rovingiz qabul qilindi! (${rental.brand} ${rental.model})`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2 style="color: #16a34a;">Tabriklaymiz! 🎉</h2>
            <p>Sizning <b>${rental.brand} ${rental.model}</b> mashinasi uchun yuborgan ijara so‘rovingiz mashina egasi tomonidan <b>TASDIQLANDI</b>.</p>
            <p>Sanalar: <b>${rental.start_date} dan ${rental.end_date} gacha</b></p>
            <p>Platformadagi chat orqali mashina egasi bilan bog‘lanib, olib ketish tafsilotlarini kelishib oling.</p>
          </div>
        `
      });
    }

    res.json({ success: true, message: 'Ijara so‘rovi tasdiqlandi!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// Reject Rental Request (Owner only)
app.post('/api/rentals/:id/reject', authenticateToken, (req, res) => {
  try {
    const rentalId = Number(req.params.id);
    const rental = db.prepare(`
      SELECT r.*, c.brand, c.model, u.email as renter_email
      FROM rentals r
      JOIN cars c ON r.car_id = c.id
      JOIN users u ON r.renter_id = u.id
      WHERE r.id = ?
    `).get(rentalId);

    if (!rental) return res.status(404).json({ success: false, message: 'Ijara topilmadi.' });
    if (rental.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Faqat mashina egasi rad etishi mumkin.' });
    }

    db.prepare("UPDATE rentals SET status = 'REJECTED' WHERE id = ?").run(rentalId);

    createNotification(
      rental.renter_id,
      'RENTAL_REJECTED',
      'Ijara so‘rovingiz rad etildi',
      `${rental.brand} ${rental.model} uchun ijara so‘rovingiz qabul qilinmadi.`
    );

    if (rental.renter_email) {
      sendEmail({
        to: rental.renter_email,
        subject: `AvtoRent — Ijara so‘rovi holati (${rental.brand} ${rental.model})`,
        html: `<p>Afsuski, <b>${rental.brand} ${rental.model}</b> uchun ijara so‘rovingiz mashina egasi tomonidan rad etildi.</p>`
      });
    }

    res.json({ success: true, message: 'Ijara so‘rovi rad etildi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// Cancel Rental Request (Renter)
app.post('/api/rentals/:id/cancel', authenticateToken, (req, res) => {
  try {
    const rentalId = Number(req.params.id);
    const rental = db.prepare('SELECT * FROM rentals WHERE id = ?').get(rentalId);
    if (!rental) return res.status(404).json({ success: false, message: 'Ijara topilmadi.' });
    if (rental.renter_id !== req.user.id && rental.owner_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Huquq yo‘q.' });
    }

    db.prepare("UPDATE rentals SET status = 'CANCELLED' WHERE id = ?").run(rentalId);
    res.json({ success: true, message: 'Ijara bekor qilindi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

// ==========================================
// CHAT & CONVERSATIONS API
// ==========================================

// Get all conversations for current user
app.get('/api/conversations', authenticateToken, (req, res) => {
  try {
    const list = db.prepare(`
      SELECT 
        c.id, c.car_id, c.renter_id, c.owner_id, c.updated_at,
        car.brand, car.model, car.main_image, car.region, car.city,
        renter.name as renter_name, renter.avatar_url as renter_avatar,
        owner.name as owner_name, owner.avatar_url as owner_avatar,
        (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) as unread_count
      FROM conversations c
      JOIN cars car ON c.car_id = car.id
      JOIN users renter ON c.renter_id = renter.id
      JOIN users owner ON c.owner_id = owner.id
      WHERE c.renter_id = ? OR c.owner_id = ?
      ORDER BY c.updated_at DESC
    `).all(req.user.id, req.user.id, req.user.id);

    // Format other party details
    const conversations = list.map(item => {
      const isRenter = item.renter_id === req.user.id;
      return {
        id: item.id,
        car_id: item.car_id,
        car_name: `${item.brand} ${item.model}`,
        car_image: item.main_image,
        car_location: `${item.city}, ${item.region}`,
        other_user: {
          id: isRenter ? item.owner_id : item.renter_id,
          name: isRenter ? item.owner_name : item.renter_name,
          avatar: isRenter ? item.owner_avatar : item.renter_avatar,
          role: isRenter ? 'Egasi' : 'Ijarachi'
        },
        last_message: item.last_message || 'Hozircha xabarlar yo‘q',
        last_message_time: item.last_message_time,
        unread_count: item.unread_count
      };
    });

    res.json({ success: true, conversations });
  } catch (err) {
    console.error('Conversations list error:', err);
    res.status(500).json({ success: false, message: 'Chatlarni yuklashda xatolik.' });
  }
});

// Start or get conversation for a car
app.post('/api/conversations', authenticateToken, (req, res) => {
  try {
    const { car_id } = req.body;
    if (!car_id) return res.status(400).json({ success: false, message: 'Mashina IDsi kerak.' });

    const car = db.prepare('SELECT id, owner_id, brand, model FROM cars WHERE id = ?').get(Number(car_id));
    if (!car) return res.status(404).json({ success: false, message: 'Mashina topilmadi.' });

    if (car.owner_id === req.user.id) {
      return res.status(400).json({ success: false, message: 'O‘z mashinangiz egasi bilan chat ocholmaysiz.' });
    }

    // Check if conversation already exists
    let conv = db.prepare(`
      SELECT id FROM conversations 
      WHERE car_id = ? AND renter_id = ? AND owner_id = ?
    `).get(car.id, req.user.id, car.owner_id);

    if (!conv) {
      const insert = db.prepare(`
        INSERT INTO conversations (car_id, renter_id, owner_id, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `);
      const result = insert.run(car.id, req.user.id, car.owner_id);
      conv = { id: Number(result.lastInsertRowid) };
    }

    res.json({ success: true, conversationId: conv.id });
  } catch (err) {
    console.error('Conversation create error:', err);
    res.status(500).json({ success: false, message: 'Chat yaratishda xatolik.' });
  }
});

// Get messages for conversation
app.get('/api/conversations/:id/messages', authenticateToken, (req, res) => {
  try {
    const convId = Number(req.params.id);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
    if (!conv) return res.status(404).json({ success: false, message: 'Chat topilmadi.' });

    if (conv.renter_id !== req.user.id && conv.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Ruxsat berilmagan.' });
    }

    // Mark unread messages as read
    db.prepare(`
      UPDATE messages SET is_read = 1 
      WHERE conversation_id = ? AND sender_id != ?
    `).run(convId, req.user.id);

    const messages = db.prepare(`
      SELECT m.*, u.name as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ?
      ORDER BY m.id ASC
    `).all(convId);

    // Car and other user info
    const car = db.prepare('SELECT id, brand, model, main_image, daily_price, city, region FROM cars WHERE id = ?').get(conv.car_id);
    const otherUserId = conv.renter_id === req.user.id ? conv.owner_id : conv.renter_id;
    const otherUser = db.prepare('SELECT id, name, surname, phone, avatar_url FROM users WHERE id = ?').get(otherUserId);

    res.json({
      success: true,
      messages,
      car,
      otherUser
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xabarlarni yuklashda xatolik.' });
  }
});

// Send message
app.post('/api/conversations/:id/messages', authenticateToken, (req, res) => {
  try {
    const convId = Number(req.params.id);
    const { text, image_url } = req.body;

    if (!text && !image_url) {
      return res.status(400).json({ success: false, message: 'Xabar matni yoki rasm kiriting.' });
    }

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
    if (!conv) return res.status(404).json({ success: false, message: 'Chat topilmadi.' });

    if (conv.renter_id !== req.user.id && conv.owner_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Ruxsat berilmagan.' });
    }

    const insert = db.prepare(`
      INSERT INTO messages (conversation_id, sender_id, text, image_url, is_read)
      VALUES (?, ?, ?, ?, 0)
    `);
    const result = insert.run(convId, req.user.id, text ? text.trim() : '', image_url || '');
    const messageId = Number(result.lastInsertRowid);

    // Update conversation timestamp
    db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(convId);

    // Notify recipient
    const recipientId = conv.renter_id === req.user.id ? conv.owner_id : conv.renter_id;
    createNotification(
      recipientId,
      'NEW_MESSAGE',
      'Yangi xabar',
      `${req.user.name}: ${text ? text.slice(0, 50) : 'Rasm yuborildi'}`,
      `/chat?conv=${convId}`
    );

    const message = db.prepare(`
      SELECT m.*, u.name as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `).get(messageId);

    res.json({ success: true, message });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ success: false, message: 'Xabar yuborishda xatolik.' });
  }
});

// ==========================================
// NOTIFICATIONS API
// ==========================================
app.get('/api/notifications', authenticateToken, (req, res) => {
  try {
    const notifications = db.prepare(`
      SELECT * FROM notifications 
      WHERE user_id = ? 
      ORDER BY id DESC LIMIT 50
    `).all(req.user.id);

    const unreadCount = db.prepare(`
      SELECT COUNT(*) as count FROM notifications 
      WHERE user_id = ? AND is_read = 0
    `).get(req.user.id).count;

    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

app.post('/api/notifications/:id/read', authenticateToken, (req, res) => {
  try {
    const notifId = Number(req.params.id);
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notifId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/notifications/read-all', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==========================================
// PROFILE API
// ==========================================
app.get('/api/profile', authenticateToken, (req, res) => {
  try {
    const user = db.prepare(`
      SELECT id, name, surname, email, phone, avatar_url, email_verified, role, created_at
      FROM users WHERE id = ?
    `).get(req.user.id);

    if (!user) return res.status(404).json({ success: false, message: 'Topilmadi.' });

    const stats = {
      cars: db.prepare('SELECT COUNT(*) as c FROM cars WHERE owner_id = ?').get(user.id).c,
      rentals: db.prepare('SELECT COUNT(*) as c FROM rentals WHERE renter_id = ? OR owner_id = ?').get(user.id, user.id).c,
      favorites: db.prepare('SELECT COUNT(*) as c FROM favorites WHERE user_id = ?').get(user.id).c
    };

    res.json({ success: true, user: { ...user, stats } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Xatolik yuz berdi.' });
  }
});

app.put('/api/profile', authenticateToken, (req, res) => {
  try {
    const { name, surname, phone, avatar_url, email } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let emailChanged = false;
    let newEmail = user.email;

    if (email && email.trim().toLowerCase() !== user.email) {
      newEmail = email.trim().toLowerCase();
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, user.id);
      if (existing) {
        return res.status(400).json({ success: false, message: 'Bu email allaqachon band.' });
      }
      emailChanged = true;
    }

    db.prepare(`
      UPDATE users SET 
        name = COALESCE(?, name),
        surname = COALESCE(?, surname),
        phone = COALESCE(?, phone),
        avatar_url = COALESCE(?, avatar_url),
        email = ?,
        email_verified = CASE WHEN ? = 1 THEN 0 ELSE email_verified END
      WHERE id = ?
    `).run(
      name ? name.trim() : null,
      surname ? surname.trim() : null,
      phone ? phone.trim() : null,
      avatar_url || null,
      newEmail,
      emailChanged ? 1 : 0,
      user.id
    );

    if (emailChanged) {
      // Create new verification code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO verification_codes (user_id, email, code, expires_at) VALUES (?, ?, ?, ?)').run(user.id, newEmail, code, expiresAt);

      sendEmail({
        to: newEmail,
        subject: 'AvtoRent — Yangilangan emailni tasdiqlash',
        html: `<p>Profilingizdagi yangi emailni tasdiqlash kodi: <b>${code}</b></p>`
      });
    }

    const updatedUser = db.prepare(`
      SELECT id, name, surname, email, phone, avatar_url, email_verified, role 
      FROM users WHERE id = ?
    `).get(user.id);

    res.json({
      success: true,
      message: emailChanged ? 'Profil yangilandi! Yangi emailingizni tasdiqlang.' : 'Profil muvaffaqiyatli saqlandi.',
      user: updatedUser,
      emailChanged
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Profilni saqlashda xatolik.' });
  }
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚗 AvtoRent Full-Stack Server Ishga Tushdi!`);
  console.log(`📍 Manzil: http://localhost:${PORT}`);
  console.log(`⚡ SQLite Database: ${dbPath}`);
  console.log(`✉️ Resend API Key: ${RESEND_API_KEY ? 'Faol' : 'O‘rnatilmagan'}`);
  console.log(`===============================================`);
});
