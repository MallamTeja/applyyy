// This is the main file for the Follow-Up Nudges page.
// We import React and useEffect/useState hooks.
import React, { useEffect, useState } from 'react';
// We import the CSS file for styling.
import './followup.css';
// We import the db client as per instructions.
// The instructions said "always use createAppUserClient() from ../_shared/db/client.ts"
// Using the correct relative path to reach the supabase functions shared folder.
import { createAppUserClient } from '../../../../../supabase/functions/_shared/db/client.ts';

// We define the Nudge interface to type our state.
interface Nudge {
    // The unique ID of the nudge.
    id: string;
    // The application ID.
    application_id: string;
    // The status of the nudge.
    status: string;
    // The draft subject line.
    draft_subject: string;
    // The draft body text.
    draft_body: string;
    // The application details.
    applications: {
        // The applied date.
        applied_at: string;
        // The job details.
        jobs: {
            // The company name.
            company_name: string;
            // The job title.
            title: string;
        };
    };
}

// We define the main component.
export const FollowUpNudgesPage = () => {
    // We declare a state variable for the nudges.
    const [nudges, setNudges] = useState<Nudge[]>([]);
    
    // We fetch nudges on mount.
    useEffect(() => {
        // We define an async function to load data.
        const loadNudges = async () => {
            // We get the DB connection.
            const conn = await createAppUserClient();
            // If connection fails, we exit.
            if (!conn.ok) return;
            // We query the follow_up_nudges table.
            const { data } = await conn.db
                // We select the necessary fields.
                .from('follow_up_nudges')
                // We select joined data.
                .select(`id, application_id, status, draft_subject, draft_body, applications ( applied_at, jobs ( company_name, title ) )`)
                // We filter by pending status.
                .eq('status', 'pending');
            // We set the fetched data to state.
            if (data) setNudges(data as unknown as Nudge[]);
        };
        // We call the load function.
        loadNudges();
    // We pass an empty dependency array.
    }, []);

    // We define a handler for opening Gmail.
    const handleOpenGmail = (nudge: Nudge) => {
        // We encode the subject.
        const sub = encodeURIComponent(nudge.draft_subject);
        // We encode the body.
        const bod = encodeURIComponent(nudge.draft_body);
        // We build the Gmail URL.
        const url = `https://mail.google.com/mail/?view=cm&fs=1&su=${sub}&body=${bod}`;
        // We open the URL in a new window.
        window.open(url, '_blank');
    };

    // We define a handler for marking as sent.
    const handleMarkSent = async (id: string) => {
        // We get the DB connection.
        const conn = await createAppUserClient();
        // If connection fails, we exit.
        if (!conn.ok) return;
        // We update the status in the DB.
        await conn.db.from('follow_up_nudges').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id);
        // We remove the item from local state.
        setNudges(nudges.filter(n => n.id !== id));
    };

    // We define a handler for snoozing.
    const handleSnooze = async (id: string) => {
        // We get the DB connection.
        const conn = await createAppUserClient();
        // If connection fails, we exit.
        if (!conn.ok) return;
        // We update the created_at to effectively snooze.
        await conn.db.from('follow_up_nudges').update({ created_at: new Date().toISOString() }).eq('id', id);
        // We remove the item from local state.
        setNudges(nudges.filter(n => n.id !== id));
    };

    // We define a handler for dismissing.
    const handleDismiss = async (id: string) => {
        // We get the DB connection.
        const conn = await createAppUserClient();
        // If connection fails, we exit.
        if (!conn.ok) return;
        // We update the status to dismissed.
        await conn.db.from('follow_up_nudges').update({ status: 'dismissed' }).eq('id', id);
        // We remove the item from local state.
        setNudges(nudges.filter(n => n.id !== id));
    };

    // We render the component UI.
    return (
        // We return the main container.
        <div className="followup-container">
            {/* We render a heading. */}
            <h1>Follow-Up Nudges</h1>
            {/* We map over the nudges to render them. */}
            {nudges.map(nudge => (
                // We render a card for each nudge.
                <div key={nudge.id} className="nudge-card">
                    {/* We show the company and title. */}
                    <h2>{nudge.applications?.jobs?.company_name} - {nudge.applications?.jobs?.title}</h2>
                    {/* We show the applied date. */}
                    <p className="applied-date">Applied at: {nudge.applications?.applied_at}</p>
                    {/* We render the subject input. */}
                    <input type="text" className="draft-subject" defaultValue={nudge.draft_subject} />
                    {/* We render the body textarea. */}
                    <textarea className="draft-body" defaultValue={nudge.draft_body} />
                    {/* We render the action buttons container. */}
                    <div className="actions">
                        {/* Button to open Gmail */}
                        <button onClick={() => handleOpenGmail(nudge)}>✉️ Copy &amp; Open Gmail</button>
                        {/* Button to mark as sent */}
                        <button onClick={() => handleMarkSent(nudge.id)}>✅ Mark as Sent</button>
                        {/* Button to snooze */}
                        <button onClick={() => handleSnooze(nudge.id)}>⏸️ Snooze 3 Days</button>
                        {/* Button to dismiss */}
                        <button onClick={() => handleDismiss(nudge.id)}>🗑️ Dismiss Nudge</button>
                    {/* We close the actions container. */}
                    </div>
                {/* We close the nudge card. */}
                </div>
            ))}
        {/* We close the main container. */}
        </div>
    );
};
