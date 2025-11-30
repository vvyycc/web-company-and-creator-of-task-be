import { Schema, model, models } from 'mongoose';

// CommunityProject se usa para mostrar proyectos en una comunidad de programadores.
const CommunityProjectSchema = new Schema(
  {
    ownerEmail: { type: String, required: true, index: true },
    projectTitle: { type: String, required: true },
    projectDescription: { type: String, required: true },
    estimation: { type: Schema.Types.Mixed, required: true }, // guarda ProjectEstimation completo
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const CommunityProject = models.CommunityProject || model('CommunityProject', CommunityProjectSchema);

