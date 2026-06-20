import mongoose, { Schema, Document } from 'mongoose';

// ── Types ──
export type TaskCategory = 'REMINDER' | 'NOTE' | 'TASK';
export type WhitelistRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface IUser extends Document {
  whatsappJid: string;
  name?: string | null;
  googleRefreshToken?: string | null;
  googleEmail?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITask extends Document {
  title: string;
  category: TaskCategory;
  dueAt?: Date | null;
  completed: boolean;
  userId: mongoose.Types.ObjectId | string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWhitelistedNumber extends Document {
  phone: string;
  label?: string | null;
  role: WhitelistRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Schemas ──
const UserSchema = new Schema<IUser>({
  whatsappJid: { type: String, required: true, unique: true },
  name: { type: String, default: null },
  googleRefreshToken: { type: String, default: null },
  googleEmail: { type: String, default: null },
}, { timestamps: true });

const TaskSchema = new Schema<ITask>({
  title: { type: String, required: true },
  category: { type: String, enum: ['REMINDER', 'NOTE', 'TASK'], required: true },
  dueAt: { type: Date, default: null },
  completed: { type: Boolean, default: false },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

// Add virtual populate if needed, though manual query is fine
UserSchema.virtual('tasks', {
  ref: 'Task',
  localField: '_id',
  foreignField: 'userId',
});

const WhitelistedNumberSchema = new Schema<IWhitelistedNumber>({
  phone: { type: String, required: true, unique: true },
  label: { type: String, default: null },
  role: { type: String, enum: ['OWNER', 'ADMIN', 'MEMBER'], default: 'MEMBER' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

// ── Models ──
export const User = mongoose.models.User || mongoose.model<IUser>('User', UserSchema, 'users');
export const Task = mongoose.models.Task || mongoose.model<ITask>('Task', TaskSchema, 'tasks');
export const WhitelistedNumber = mongoose.models.WhitelistedNumber || mongoose.model<IWhitelistedNumber>('WhitelistedNumber', WhitelistedNumberSchema, 'whitelisted_numbers');
