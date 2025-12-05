import mongoose from 'mongoose';

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/task-platform';

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(mongoUri);
  console.log('MongoDB connected:', mongoUri);
}
